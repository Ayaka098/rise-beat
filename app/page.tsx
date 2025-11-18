"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";

type MediaKind = "audio" | "video";

type MediaFile = {
  id: string;
  name: string;
  mimeType: string;
  kind: MediaKind;
  createdAt: string;
  durationSec?: number;
  hasBlob?: boolean;
};

type Playlist = {
  id: string;
  name: string;
  fileIds: string[];
};

type AlarmSetting = {
  time: string;
  playlistId: string | null;
  memo: string;
  isOn: boolean;
  nextTrigger?: string;
};

const MEDIA_KEY = "riseBeat_media";
const PLAYLIST_KEY = "riseBeat_playlists";
const ALARM_KEY = "riseBeat_alarm";

const DB_NAME = "riseBeatMediaStore";
const DB_VERSION = 1;
const STORE_NAME = "files";

const DEFAULT_ALARM: AlarmSetting = {
  time: "07:00",
  playlistId: null,
  memo: "",
  isOn: false,
};

let mediaDbPromise: Promise<IDBDatabase | null> | null = null;

const isBrowser = () => typeof window !== "undefined";

function safeRead<T>(key: string): T | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (error) {
    console.warn(`Failed to parse ${key}`, error);
    return null;
  }
}

function formatDuration(seconds?: number | null) {
  if (!seconds || seconds <= 0) return "--:--";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  }
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatClock(date: Date) {
  return `${date.getHours().toString().padStart(2, "0")}:${date
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

function formatRemaining(seconds: number) {
  const positive = Math.max(seconds, 0);
  const mins = Math.floor(positive / 60);
  const secs = Math.floor(positive % 60);
  return `${mins}分${secs.toString().padStart(2, "0")}秒`;
}

async function openMediaDb() {
  if (!isBrowser()) return null;
  if (mediaDbPromise) return mediaDbPromise;
  mediaDbPromise = new Promise((resolve) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      console.error("indexedDB open failed", request.error);
      resolve(null);
    };
  });
  return mediaDbPromise;
}

async function storeBlob(id: string, file: Blob) {
  const db = await openMediaDb();
  if (!db) return;
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE_NAME).put(file, id);
  });
}

async function readBlob(id: string) {
  const db = await openMediaDb();
  if (!db) return null;
  return new Promise<Blob | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => {
      resolve(request.result ?? null);
    };
    request.onerror = () => reject(request.error);
  });
}

async function removeBlob(id: string) {
  const db = await openMediaDb();
  if (!db) return;
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE_NAME).delete(id);
  });
}

async function readMediaDuration(blob: Blob, kind: MediaKind) {
  if (!isBrowser()) return undefined;
  return new Promise<number | undefined>((resolve) => {
    const element = document.createElement(kind === "video" ? "video" : "audio");
    element.preload = "metadata";
    const url = URL.createObjectURL(blob);
    element.src = url;
    element.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      if (element.duration && Number.isFinite(element.duration)) {
        resolve(Math.round(element.duration));
      } else {
        resolve(undefined);
      }
    };
    element.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(undefined);
    };
  });
}

function calculateNextTrigger(time: string) {
  if (!time || !/^\d{2}:\d{2}$/.test(time)) return null;
  const [hour, minute] = time.split(":").map(Number);
  const now = new Date();
  const candidate = new Date();
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

function playlistDurationSec(playlist: Playlist, files: MediaFile[]) {
  const lookup = new Map(files.map((file) => [file.id, file]));
  return playlist.fileIds.reduce((acc, id) => {
    const file = lookup.get(id);
    return acc + (file?.durationSec ?? 0);
  }, 0);
}

export default function Home() {
  const [ready, setReady] = useState(false);
  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [alarm, setAlarm] = useState<AlarmSetting>(DEFAULT_ALARM);
  const [editingPlaylist, setEditingPlaylist] = useState<Playlist | null>(null);
  const [unpersistedId, setUnpersistedId] = useState<string | null>(null);
  const [needsManualPlay, setNeedsManualPlay] = useState(false);
  const [playbackPlaylistId, setPlaybackPlaylistId] = useState<string | null>(null);
  const [currentTrackIndex, setCurrentTrackIndex] = useState(0);
  const [currentTrackUrl, setCurrentTrackUrl] = useState<string | null>(null);
  const [playbackMessage, setPlaybackMessage] = useState<string>("待機中");
  const [isPlaying, setIsPlaying] = useState(false);
  const [missingObjectUrl, setMissingObjectUrl] = useState(false);
  const [userInteracted, setUserInteracted] = useState(false);
  const [mediaSurface, setMediaSurface] = useState<MediaKind>("video");
  const sessionUrls = useRef(new Map<string, string>());
  const mediaElementRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const alarmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processedDurations = useRef(new Set<string>());
  const [progressSnapshot, setProgressSnapshot] = useState({ remaining: 0, percent: 0 });
  const isiOS = useMemo(() => {
    if (!isBrowser()) return false;
    return /iP(hone|ad|od)/i.test(window.navigator.userAgent);
  }, []);
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});


  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!isBrowser()) return;
    const storedMedia = safeRead<MediaFile[]>(MEDIA_KEY) ?? [];
    const normalizedMedia = storedMedia.map((file) => ({
      ...file,
      hasBlob: file.hasBlob ?? false,
    }));
    setMediaFiles(normalizedMedia);
    const storedPlaylists = safeRead<Playlist[]>(PLAYLIST_KEY) ?? [];
    setPlaylists(storedPlaylists);
    const storedAlarm = safeRead<AlarmSetting>(ALARM_KEY);
    const mergedAlarm: AlarmSetting = { ...DEFAULT_ALARM, ...(storedAlarm ?? {}) };
    if (mergedAlarm.playlistId) {
      const target = storedPlaylists.find((playlist) => playlist.id === mergedAlarm.playlistId);
      if (!target || target.fileIds.length === 0) {
        mergedAlarm.playlistId = null;
        mergedAlarm.isOn = false;
        mergedAlarm.nextTrigger = undefined;
      }
    }
    setAlarm(mergedAlarm);
    setReady(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!ready || !isBrowser()) return;
    window.localStorage.setItem(MEDIA_KEY, JSON.stringify(mediaFiles));
  }, [mediaFiles, ready]);

  useEffect(() => {
    if (!ready || !isBrowser()) return;
    window.localStorage.setItem(PLAYLIST_KEY, JSON.stringify(playlists));
  }, [playlists, ready]);

  useEffect(() => {
    if (!ready || !isBrowser()) return;
    window.localStorage.setItem(ALARM_KEY, JSON.stringify(alarm));
  }, [alarm, ready]);

  useEffect(() => {
    if (!isBrowser()) return;
    const handleFirstInteraction = () => {
      setUserInteracted(true);
    };
    window.addEventListener("pointerdown", handleFirstInteraction, { once: true });
    window.addEventListener("keydown", handleFirstInteraction, { once: true });
    return () => {
      window.removeEventListener("pointerdown", handleFirstInteraction);
      window.removeEventListener("keydown", handleFirstInteraction);
    };
  }, []);

  useEffect(() => {
    const cache = sessionUrls.current;
    return () => {
      cache.forEach((url) => URL.revokeObjectURL(url));
      cache.clear();
    };
  }, []);


  const detachAlarmTimeout = useCallback(() => {
    if (alarmTimeoutRef.current) {
      clearTimeout(alarmTimeoutRef.current);
      alarmTimeoutRef.current = null;
    }
  }, []);

  const ensureDuration = useCallback(
    async (file: MediaFile) => {
      if (processedDurations.current.has(file.id)) return;
      if (!file.hasBlob || file.durationSec) return;
      const blob = await readBlob(file.id);
      if (!blob) return;
      const durationSec = await readMediaDuration(blob, file.kind);
      if (durationSec) {
        processedDurations.current.add(file.id);
        setMediaFiles((prev) =>
          prev.map((entry) => (entry.id === file.id ? { ...entry, durationSec } : entry)),
        );
      }
    },
    [],
  );

  useEffect(() => {
    mediaFiles.forEach((file) => {
      if (!file.durationSec && file.hasBlob) {
        void ensureDuration(file);
      }
    });
  }, [mediaFiles, ensureDuration]);

  const playlistTotalDuration = useMemo(() => {
    if (!editingPlaylist) return 0;
    return playlistDurationSec(editingPlaylist, mediaFiles);
  }, [editingPlaylist, mediaFiles]);

  const loadTrackUrl = useCallback(
    async (fileId: string) => {
      if (!fileId) return null;
      if (sessionUrls.current.has(fileId)) {
        return sessionUrls.current.get(fileId) ?? null;
      }
      const blob = await readBlob(fileId);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      sessionUrls.current.set(fileId, url);
      return url;
    },
    [],
  );

  const currentTrack = useMemo(() => {
    if (!playbackPlaylistId) return null;
    const playlist = playlists.find((p) => p.id === playbackPlaylistId);
    if (!playlist) return null;
    const mediaId = playlist.fileIds[currentTrackIndex];
    if (!mediaId) return null;
    return mediaFiles.find((file) => file.id === mediaId) ?? null;
  }, [playbackPlaylistId, playlists, currentTrackIndex, mediaFiles]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (currentTrack?.kind) {
      setMediaSurface(currentTrack.kind);
    }
  }, [currentTrack?.kind]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const activeMediaSurface = currentTrack?.kind ?? mediaSurface;

  const handleVideoElement = useCallback(
    (element: HTMLVideoElement | null) => {
      videoElementRef.current = element;
      if (activeMediaSurface === "video") {
        mediaElementRef.current = element;
      }
    },
    [activeMediaSurface],
  );

  const handleAudioElement = useCallback(
    (element: HTMLAudioElement | null) => {
      audioElementRef.current = element;
      if (activeMediaSurface === "audio") {
        mediaElementRef.current = element;
      }
    },
    [activeMediaSurface],
  );

  useEffect(() => {
    mediaElementRef.current =
      activeMediaSurface === "video" ? videoElementRef.current : audioElementRef.current;
  }, [activeMediaSurface]);

  const startPlayback = useCallback(
    (playlistId: string, fromAlarm = false) => {
      const playlist = playlists.find((p) => p.id === playlistId);
      if (!playlist || playlist.fileIds.length === 0) {
        setPlaybackMessage("再生できるトラックがありません");
        setPlaybackPlaylistId(null);
        setIsPlaying(false);
        return;
      }
      const requiresManualStart = fromAlarm && isiOS && !userInteracted;
      const firstFileId = playlist.fileIds[0];
      if (firstFileId) {
        const firstFile = mediaFiles.find((file) => file.id === firstFileId);
        if (firstFile) {
          setMediaSurface(firstFile.kind);
        }
      }
      setPlaybackPlaylistId(playlistId);
      setCurrentTrackIndex(0);
      setIsPlaying(true);
      setNeedsManualPlay(requiresManualStart);
      setPlaybackMessage(
        requiresManualStart
          ? "iPhoneでは「再生を開始する」をタップして再生してください"
          : fromAlarm
            ? "アラームから再生を開始しました"
            : "再生を開始しました",
      );
    },
    [isiOS, playlists, userInteracted, mediaFiles],
  );

  useEffect(() => {
    detachAlarmTimeout();
    const playlistId = alarm.playlistId;
    if (!alarm.isOn || !alarm.nextTrigger || !playlistId) return;
    const target = new Date(alarm.nextTrigger).getTime();
    const delay = Math.max(target - Date.now(), 0);
    alarmTimeoutRef.current = setTimeout(() => {
      startPlayback(playlistId, true);
      const next = calculateNextTrigger(alarm.time);
      setAlarm((prev) => ({
        ...prev,
        nextTrigger: next?.toISOString(),
      }));
    }, delay);
    return () => detachAlarmTimeout();
  }, [alarm, detachAlarmTimeout, startPlayback]);

  const stopPlayback = useCallback(() => {
    setIsPlaying(false);
    setPlaybackPlaylistId(null);
    setCurrentTrackIndex(0);
    setCurrentTrackUrl(null);
    setNeedsManualPlay(false);
    setMissingObjectUrl(false);
    if (mediaElementRef.current) {
      mediaElementRef.current.pause();
      mediaElementRef.current.currentTime = 0;
    }
    setProgressSnapshot({ remaining: 0, percent: 0 });
  }, []);

  const advanceTrack = useCallback(
    (reason?: string) => {
      if (!playbackPlaylistId) return;
      const playlist = playlists.find((p) => p.id === playbackPlaylistId);
      if (!playlist) {
        stopPlayback();
        return;
      }
      if (reason) {
        setPlaybackMessage(reason);
      }
      if (currentTrackIndex + 1 < playlist.fileIds.length) {
        setCurrentTrackIndex((index) => index + 1);
      } else {
        setPlaybackMessage("プレイリストを再生し終えました");
        stopPlayback();
      }
    },
    [playbackPlaylistId, playlists, currentTrackIndex, stopPlayback],
  );

  const attemptPlay = useCallback(async () => {
    const element = mediaElementRef.current;
    if (!element) return;
    if (isiOS && !userInteracted) {
      setNeedsManualPlay(true);
      setPlaybackMessage("再生を開始するボタンをタップしてください");
      return;
    }
    try {
      await element.play();
      setNeedsManualPlay(false);
      setPlaybackMessage("再生中");
    } catch (error) {
      console.error("Failed to start media playback", error);
      setNeedsManualPlay(true);
      setPlaybackMessage("自動再生できません。ボタンで開始してください");
    }
  }, [isiOS, userInteracted]);

  useEffect(() => {
    let cancelled = false;
    const setup = async () => {
      if (!currentTrack) {
        setCurrentTrackUrl(null);
        setMissingObjectUrl(false);
        return;
      }
      const url = await loadTrackUrl(currentTrack.id);
      if (cancelled) return;
      if (!url) {
        setMissingObjectUrl(true);
        advanceTrack();
        return;
      }
      setMissingObjectUrl(false);
      setCurrentTrackUrl(url);
    };
    void setup();
    return () => {
      cancelled = true;
    };
  }, [currentTrack, loadTrackUrl, advanceTrack]);

  const handleManualPlay = () => {
    setUserInteracted(true);
    void attemptPlay();
  };

  const handleEnterFullscreen = () => {
    const element = videoElementRef.current;
    if (!element) return;
    if (element.requestFullscreen) {
      element.requestFullscreen().catch(() => {
        // ignore
      });
      return;
    }
    const webkitEnterFullscreen = (element as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen;
    if (webkitEnterFullscreen) {
      try {
        webkitEnterFullscreen.call(element);
      } catch {
        // ignore
      }
    }
  };

  useEffect(() => {
    if (!isPlaying || !currentTrack || !playbackPlaylistId) return;
    const interval = setInterval(() => {
      const playlist = playlists.find((p) => p.id === playbackPlaylistId);
      if (!playlist) return;
      const total = playlistDurationSec(playlist, mediaFiles);
      const completed = playlist.fileIds
        .slice(0, currentTrackIndex)
        .reduce((acc, id) => {
          const file = mediaFiles.find((entry) => entry.id === id);
          return acc + (file?.durationSec ?? 0);
        }, 0);
      const currentTime = mediaElementRef.current?.currentTime ?? 0;
      const played = completed + currentTime;
      const percent = total > 0 ? Math.min(100, Math.round((played / total) * 100)) : 0;
      const remaining = Math.max(total - played, 0);
      setProgressSnapshot({ remaining, percent });
    }, 1000);
    return () => clearInterval(interval);
  }, [isPlaying, currentTrack, playlists, playbackPlaylistId, mediaFiles, currentTrackIndex]);

  const editingPlaylistDuration = formatDuration(playlistTotalDuration);
  const editingPlaylistIsSaved = useMemo(
    () => (editingPlaylist ? playlists.some((playlist) => playlist.id === editingPlaylist.id) : false),
    [editingPlaylist, playlists],
  );

  const alarmPlaylist = useMemo(() => playlists.find((p) => p.id === alarm.playlistId) ?? null, [playlists, alarm.playlistId]);

  const alarmPlaylistDurationSec = useMemo(() => (alarmPlaylist ? playlistDurationSec(alarmPlaylist, mediaFiles) : 0), [alarmPlaylist, mediaFiles]);

  const plannedStartDate = useMemo(() => {
    if (alarm.isOn && alarm.nextTrigger) return new Date(alarm.nextTrigger);
    return calculateNextTrigger(alarm.time);
  }, [alarm]);

  const plannedEndDate = useMemo(() => {
    if (!plannedStartDate || !alarmPlaylistDurationSec) return null;
    return new Date(plannedStartDate.getTime() + alarmPlaylistDurationSec * 1000);
  }, [plannedStartDate, alarmPlaylistDurationSec]);

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;
    const additions: MediaFile[] = [];
    for (const file of Array.from(files)) {
      const id = crypto.randomUUID();
      const kind: MediaKind = file.type.startsWith("video") ? "video" : "audio";
      await storeBlob(id, file);
      const durationSec = await readMediaDuration(file, kind);
      additions.push({
        id,
        name: file.name,
        mimeType: file.type || (kind === "video" ? "video/mp4" : "audio/mpeg"),
        kind,
        createdAt: new Date().toISOString(),
        durationSec,
        hasBlob: true,
      });
    }
    setMediaFiles((prev) => [...prev, ...additions]);
    event.target.value = "";
  };

  const handleRemoveMedia = async (id: string) => {
    if (!window.confirm("このファイルを削除しますか？")) {
      return;
    }
    const alarmPlaylistId = alarm.playlistId;
    setPlaylists((prev) => {
      const updated = prev.map((playlist) => ({
        ...playlist,
        fileIds: playlist.fileIds.filter((fileId) => fileId !== id),
      }));
      if (alarmPlaylistId) {
        const target = updated.find((playlist) => playlist.id === alarmPlaylistId);
        if (!target || target.fileIds.length === 0) {
          setAlarm((prevAlarm) => ({
            ...prevAlarm,
            playlistId: target ? prevAlarm.playlistId : null,
            isOn: false,
            nextTrigger: undefined,
          }));
        }
      }
      return updated;
    });
    setMediaFiles((prev) => prev.filter((file) => file.id !== id));
    setEditingPlaylist((prev) =>
      prev ? { ...prev, fileIds: prev.fileIds.filter((fileId) => fileId !== id) } : prev,
    );
    setNameDrafts((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    const url = sessionUrls.current.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      sessionUrls.current.delete(id);
    }
    await removeBlob(id);
  };

  const updateNameDraft = (id: string, value: string) => {
    setNameDrafts((prev) => ({ ...prev, [id]: value }));
  };

  const clearNameDraft = (id: string) => {
    setNameDrafts((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const handleNameCommit = (id: string) => {
    const draft = nameDrafts[id];
    const trimmed = (draft ?? "").trim();
    if (!draft || !trimmed) {
      clearNameDraft(id);
      return;
    }
    setMediaFiles((prev) =>
      prev.map((file) => (file.id === id ? { ...file, name: trimmed } : file)),
    );
    clearNameDraft(id);
  };

  const handleNameReset = (id: string) => {
    clearNameDraft(id);
  };

  const handleNameKeyDown = (event: KeyboardEvent<HTMLInputElement>, id: string) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleNameCommit(id);
    }
  };

  const handlePlaylistSelect = (id: string) => {
    const playlist = playlists.find((entry) => entry.id === id);
    if (!playlist) return;
    setEditingPlaylist({ ...playlist });
    setUnpersistedId(null);
  };

  const handleCreatePlaylist = () => {
    const newId = crypto.randomUUID();
    setEditingPlaylist({ id: newId, name: "新しいプレイリスト", fileIds: [] });
    setUnpersistedId(newId);
  };

  const updateEditingPlaylist = (updater: (prev: Playlist) => Playlist) => {
    setEditingPlaylist((prev) => (prev ? updater(prev) : prev));
  };

  const handlePlaylistSave = () => {
    if (!editingPlaylist) return;
    if (!editingPlaylist.name.trim()) return;
    setPlaylists((prev) => {
      const exists = prev.some((playlist) => playlist.id === editingPlaylist.id);
      if (exists) {
        return prev.map((playlist) => (playlist.id === editingPlaylist.id ? editingPlaylist : playlist));
      }
      return [...prev, editingPlaylist];
    });
    setUnpersistedId(null);
  };

  const handlePlaylistDelete = (id: string) => {
    if (
      !window.confirm("このプレイリストを削除しますか？")
    ) {
      return;
    }
    setPlaylists((prev) => prev.filter((playlist) => playlist.id !== id));
    if (alarm.playlistId === id) {
      setAlarm((prev) => ({ ...prev, playlistId: null, isOn: false, nextTrigger: undefined }));
    }
    if (editingPlaylist?.id === id) {
      setEditingPlaylist(null);
    }
  };

  const handleAlarmToggle = () => {
    if (!alarm.playlistId) {
      setPlaybackMessage("プレイリストを選択してください");
      return;
    }
    const playlist = playlists.find((entry) => entry.id === alarm.playlistId);
    if (!playlist || playlist.fileIds.length === 0) {
      setPlaybackMessage("ファイルが入ったプレイリストを選んでください");
      return;
    }
    if (!alarm.isOn) {
      const next = calculateNextTrigger(alarm.time);
      setAlarm((prev) => ({ ...prev, isOn: true, nextTrigger: next?.toISOString() }));
    } else {
      detachAlarmTimeout();
      setAlarm((prev) => ({ ...prev, isOn: false, nextTrigger: undefined }));
    }
  };

  const playlistCards = playlists.map((playlist) => {
    const duration = playlistDurationSec(playlist, mediaFiles);
    return (
      <button
        key={playlist.id}
        className={`rounded-2xl bg-white/70 p-4 text-left shadow-sm transition hover:shadow-md ${
          editingPlaylist?.id === playlist.id ? "ring-2 ring-[#c5afff]" : ""
        }`}
        onClick={() => handlePlaylistSelect(playlist.id)}
      >
        <p className="text-lg font-semibold text-slate-900">{playlist.name}</p>
        <p className="text-sm text-slate-500">{playlist.fileIds.length}ファイル</p>
        <p className="text-sm text-[#3f8f7e]">合計 {formatDuration(duration)}</p>
      </button>
    );
  });

  const availableMediaOptions = mediaFiles.map((file) => (
    <option key={file.id} value={file.id}>
      {file.name}
    </option>
  ));

  const currentPlaylistName = useMemo(() => playlists.find((p) => p.id === playbackPlaylistId)?.name ?? "--", [playlists, playbackPlaylistId]);

  const currentPlaylistProgressText = isPlaying
    ? `残り ${formatRemaining(progressSnapshot.remaining)} / 進捗 ${progressSnapshot.percent}%`
    : "停止中";

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_#f1edff,_#d4c1ff_45%,_#b6ffe5_80%,_#e9fff7)] text-slate-900">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-2">
          <h1 className="text-4xl font-semibold tracking-tight text-[#5d3d82] md:text-5xl">Rise Beat</h1>
          <p className="text-xs uppercase tracking-[0.4em] text-[#3d8b7b]">
            お気に入りのプレイリストで目覚めるアラーム
          </p>
          <p className="text-base text-slate-700">
            ファイルをアップロードしてプレイリストを作成し、毎朝のルーティンに合わせてアラームを鳴らしましょう。
          </p>
        </header>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-3xl bg-white/80 p-6 shadow-xl backdrop-blur">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">ファイルライブラリ</h2>
              <label className="cursor-pointer rounded-full bg-[#cdb6ff] px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-[#bba4f3]">
                追加する
                <input
                  type="file"
                  className="hidden"
                  multiple
                  onChange={handleUpload}
                  accept="audio/*,video/*"
                />
              </label>
            </div>
            <p className="mt-2 text-sm text-slate-500">
              ブラウザに安全に保存され、再読み込み後もそのまま再生できます。
            </p>
            <div className="mt-4 flex max-h-[360px] flex-col gap-3 overflow-y-auto pr-1">
              {mediaFiles.length === 0 && (
                <p className="text-sm text-slate-500">まだファイルがありません。</p>
              )}
              {mediaFiles.map((file) => {
                const draftName = nameDrafts[file.id] ?? file.name;
                const canSave = draftName.trim().length > 0 && draftName.trim() !== file.name;
                const isEditing = nameDrafts[file.id] !== undefined;
                return (
                  <div key={file.id} className="rounded-2xl bg-white/70 p-3 text-sm text-slate-700 shadow-sm">
                    <div className="flex flex-col gap-1">
                      <input
                        value={draftName}
                        onChange={(event) => updateNameDraft(file.id, event.target.value)}
                        onKeyDown={(event) => handleNameKeyDown(event, file.id)}
                        className="rounded-lg border border-[#d6c9ff] bg-white px-3 py-1.5 text-sm font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#aef5d9]"
                      />
                      <div className="flex flex-wrap gap-x-3 text-xs text-slate-500">
                        <span>{file.kind.toUpperCase()}</span>
                        <span>追加 {new Date(file.createdAt).toLocaleDateString()}</span>
                        <span>再生 {formatDuration(file.durationSec)}</span>
                        <span>{file.hasBlob ? "保存済み" : "再生不可 (旧データ)"}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2">
                        <button
                          className="rounded-full bg-[#cdb6ff] px-3 py-1 text-xs font-semibold text-slate-900 disabled:opacity-40"
                          onClick={() => handleNameCommit(file.id)}
                          disabled={!canSave}
                        >
                          名前を保存
                        </button>
                        {isEditing && (
                          <button
                            className="rounded-full border border-slate-300 px-3 py-1 text-xs text-slate-700"
                            onClick={() => handleNameReset(file.id)}
                          >
                            リセット
                          </button>
                        )}
                        <button
                          className="rounded-full bg-[#9fffe0] px-3 py-1 text-xs font-semibold text-slate-900"
                          onClick={() => handleRemoveMedia(file.id)}
                        >
                          削除
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-3xl bg-white/80 p-6 shadow-xl backdrop-blur">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">プレイリスト</h2>
              <button
                className="rounded-full bg-[#cdb6ff] px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-[#bba4f3]"
                onClick={handleCreatePlaylist}
              >
                新規作成
              </button>
            </div>
            <p className="mt-2 text-sm text-slate-500">
              合計時間を参考に、朝のタスクに合わせた順序で並べ替えてください。
            </p>
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {playlistCards.length > 0 ? playlistCards : <p className="text-sm text-slate-500">プレイリストがありません。</p>}
            </div>
            {editingPlaylist && (
              <div className="mt-5 rounded-2xl bg-white/70 p-4 shadow-sm">
                <div className="flex flex-col gap-3">
                  <input
                    value={editingPlaylist.name}
                    onChange={(event) =>
                      updateEditingPlaylist((prev) => ({ ...prev, name: event.target.value }))
                    }
                    className="w-full rounded-xl border border-[#d6c9ff] bg-white px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#aef5d9]"
                  />
                  <div className="text-sm text-slate-600">
                    合計 {editingPlaylistDuration} / {editingPlaylist.fileIds.length} トラック
                  </div>
                  <div className="flex flex-col gap-2">
                    {editingPlaylist.fileIds.map((id, index) => {
                      const file = mediaFiles.find((entry) => entry.id === id);
                      if (!file) return null;
                      return (
                        <div
                          key={id}
                          className="flex items-center justify-between rounded-xl bg-white px-3 py-2 text-sm shadow-sm"
                        >
                          <div>
                            <p className="font-semibold">{file.name}</p>
                            <p className="text-xs text-slate-500">{formatDuration(file.durationSec)}</p>
                          </div>
                          <div className="flex gap-2">
                            <button
                              className="rounded-full bg-[#cdb6ff] px-2 py-1 text-xs font-semibold text-slate-900 disabled:opacity-40"
                              onClick={() =>
                                updateEditingPlaylist((prev) => {
                                  const copy = [...prev.fileIds];
                                  if (index === 0) return prev;
                                  [copy[index - 1], copy[index]] = [copy[index], copy[index - 1]];
                                  return { ...prev, fileIds: copy };
                                })
                              }
                            >
                              ↑
                            </button>
                            <button
                              className="rounded-full bg-[#cdb6ff] px-2 py-1 text-xs font-semibold text-slate-900 disabled:opacity-40"
                              onClick={() =>
                                updateEditingPlaylist((prev) => {
                                  const copy = [...prev.fileIds];
                                  if (index === copy.length - 1) return prev;
                                  [copy[index + 1], copy[index]] = [copy[index], copy[index + 1]];
                                  return { ...prev, fileIds: copy };
                                })
                              }
                            >
                              ↓
                            </button>
                            <button
                              className="rounded-full bg-[#ffd3e2] px-2 py-1 text-xs font-semibold text-[#8b223f]"
                              onClick={() =>
                                updateEditingPlaylist((prev) => ({
                                  ...prev,
                                  fileIds: prev.fileIds.filter((fileId) => fileId !== id),
                                }))
                              }
                            >
                              削除
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <select
                    className="rounded-xl border border-[#d6c9ff] bg-white px-3 py-2 text-sm"
                    value=""
                    onChange={(event) => {
                      const value = event.target.value;
                      if (!value) return;
                      updateEditingPlaylist((prev) => ({
                        ...prev,
                        fileIds: prev.fileIds.concat(value),
                      }));
                    }}
                  >
                    <option value="" disabled>
                      ファイルを追加
                    </option>
                    {availableMediaOptions}
                  </select>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="rounded-full bg-[#cdb6ff] px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-50"
                      onClick={handlePlaylistSave}
                      disabled={!editingPlaylist.name.trim() || editingPlaylist.fileIds.length === 0}
                    >
                      保存
                    </button>
                    <button
                      className="rounded-full bg-[#9fffe0] px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-50"
                      disabled={!editingPlaylistIsSaved || editingPlaylist.fileIds.length === 0}
                      onClick={() => startPlayback(editingPlaylist.id)}
                    >
                      すぐに再生
                    </button>
                    {editingPlaylist && (
                      <button
                        className="rounded-full border border-slate-300 px-4 py-2 text-sm text-slate-700"
                        onClick={() =>
                          setEditingPlaylist(
                            unpersistedId === editingPlaylist.id
                              ? null
                              : playlists.find((playlist) => playlist.id === editingPlaylist.id) ?? null,
                          )
                        }
                      >
                        リセット
                      </button>
                    )}
                    {editingPlaylist && (
                      <button
                        className="rounded-full bg-[#ffd3e2] px-4 py-2 text-sm font-semibold text-[#8b223f]"
                        onClick={() => handlePlaylistDelete(editingPlaylist.id)}
                      >
                        プレイリスト削除
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-3xl bg-white/80 p-6 shadow-lg backdrop-blur">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">アラーム</h2>
              <button
                className={`rounded-full px-4 py-2 text-sm font-semibold ${
                  alarm.isOn ? "bg-[#9fffe0] text-slate-900" : "bg-[#e5dafc]"
                }`}
                onClick={handleAlarmToggle}
              >
                {alarm.isOn ? "停止" : "セット"}
              </button>
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="flex flex-col text-sm text-slate-600">
                開始時刻
                <input
                  type="time"
                  value={alarm.time}
                  className="mt-1 rounded-xl border border-[#d6c9ff] bg-white px-3 py-2 text-base text-slate-900"
                  onChange={(event) =>
                    setAlarm((prev) => ({
                      ...prev,
                      time: event.target.value,
                      nextTrigger: prev.isOn ? calculateNextTrigger(event.target.value)?.toISOString() : prev.nextTrigger,
                    }))
                  }
                />
              </label>
              <label className="flex flex-col text-sm text-slate-600">
                プレイリスト
                <select
                  value={alarm.playlistId ?? ""}
                  className="mt-1 rounded-xl border border-[#d6c9ff] bg-white px-3 py-2 text-base text-slate-900"
                  onChange={(event) =>
                    setAlarm((prev) => ({
                      ...prev,
                      playlistId: event.target.value || null,
                    }))
                  }
                >
                  <option value="">未選択</option>
                  {playlists.map((playlist) => (
                    <option key={playlist.id} value={playlist.id}>
                      {playlist.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="mt-4 flex flex-col text-sm text-slate-600">
              メモ
              <textarea
                className="mt-1 h-24 rounded-2xl border border-[#d6c9ff] bg-white p-3 text-slate-900"
                value={alarm.memo}
                onChange={(event) => setAlarm((prev) => ({ ...prev, memo: event.target.value }))}
              />
            </label>
            <div className="mt-4 grid gap-2 text-sm text-slate-600">
              <p>プレイリスト合計時間: {formatDuration(alarmPlaylistDurationSec)}</p>
              <p>終了予定時刻: {plannedEndDate ? `${formatClock(plannedEndDate)} ごろ` : "--"}</p>
              {plannedStartDate && plannedEndDate && plannedEndDate < plannedStartDate && (
                <p className="text-xs text-[#e27fa5]">※日付をまたぎます</p>
              )}
            </div>
          </div>

          <div className="rounded-3xl bg-white/80 p-6 shadow-lg backdrop-blur">
            <h2 className="text-xl font-semibold">再生ステータス</h2>
            <div className="mt-4 space-y-3 text-sm text-slate-600">
              <p>対象プレイリスト: {currentPlaylistName}</p>
              <p>
                現在のトラック: {currentTrack?.name ?? "--"}{" "}
                {currentTrack && `(${formatDuration(currentTrack.durationSec)})`}
              </p>
              <p>状態: {playbackMessage}</p>
              <p>{currentPlaylistProgressText}</p>
            </div>
            <div className="mt-4 h-2 rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-[#9fffe0] transition-all"
                style={{ width: `${progressSnapshot.percent}%` }}
              />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="rounded-full bg-[#9fffe0] px-4 py-2 text-sm font-semibold text-slate-900" onClick={stopPlayback}>
                停止
              </button>
              {currentTrack?.kind === "video" && (
                <button
                  className="rounded-full bg-[#e5dafc] px-4 py-2 text-sm font-semibold text-slate-900"
                  onClick={handleEnterFullscreen}
                  disabled={!currentTrackUrl}
                >
                  全画面表示
                </button>
              )}
              {needsManualPlay && (
                <button className="rounded-full bg-[#9fffe0] px-4 py-2 text-sm font-semibold text-slate-900" onClick={handleManualPlay}>
                  再生を開始する
                </button>
              )}
            </div>
            <div className="mt-6 rounded-2xl bg-white/70 p-4 shadow-inner">
              <video
                ref={handleVideoElement}
                src={activeMediaSurface === "video" ? currentTrackUrl ?? undefined : undefined}
                controls={false}
                playsInline
                disablePictureInPicture
                controlsList="nodownload noremoteplayback"
                preload="auto"
                className="aspect-video w-full rounded-xl bg-black transition-all"
                style={{
                  opacity: activeMediaSurface === "video" && currentTrackUrl ? 1 : 0,
                  height: activeMediaSurface === "video" && currentTrackUrl ? undefined : 0,
                  width: activeMediaSurface === "video" && currentTrackUrl ? "100%" : 0,
                  pointerEvents: activeMediaSurface === "video" && currentTrackUrl ? "auto" : "none",
                  overflow: "hidden",
                }}
                onEnded={() => advanceTrack()}
                onCanPlay={() => {
                  if (activeMediaSurface === "video") {
                    void attemptPlay();
                  }
                }}
              />
              <audio
                ref={handleAudioElement}
                src={activeMediaSurface === "audio" ? currentTrackUrl ?? undefined : undefined}
                onCanPlay={() => {
                  if (activeMediaSurface === "audio") {
                    void attemptPlay();
                  }
                }}
                onEnded={() => advanceTrack()}
                controls={false}
                preload="auto"
                className="w-full"
                style={{
                  width: activeMediaSurface === "audio" && currentTrackUrl ? "100%" : 0,
                  height: activeMediaSurface === "audio" && currentTrackUrl ? undefined : 0,
                  opacity: activeMediaSurface === "audio" && currentTrackUrl ? 1 : 0,
                  pointerEvents: activeMediaSurface === "audio" && currentTrackUrl ? "auto" : "none",
                  overflow: "hidden",
                }}
              />
              {!currentTrack && (
                <p className="text-xs text-slate-500">再生中のトラックはありません。</p>
              )}
              {currentTrack?.kind === "audio" && (
                <p className="text-xs text-slate-500">音声トラックを再生中です。</p>
              )}
              {missingObjectUrl && (
                <p className="mt-2 text-xs text-[#e27fa5]">ファイルが見つからないためスキップしました。</p>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
