"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type MediaKind = "audio" | "video";

type MediaFile = {
  id: string;
  name: string;
  mimeType: string;
  kind: MediaKind;
  createdAt: number;
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
  nextTrigger: number | null;
};

const MEDIA_KEY = "riseBeat_media";
const PLAYLIST_KEY = "riseBeat_playlists";
const ALARM_KEY = "riseBeat_alarm";

const initialAlarm: AlarmSetting = {
  time: "",
  playlistId: null,
  memo: "",
  isOn: false,
  nextTrigger: null,
};

const cardClass =
  "rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm";
const sectionTitleClass = "text-xl font-semibold text-zinc-900";

export default function Home() {
  const [hydrated, setHydrated] = useState(false);
  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [alarm, setAlarm] = useState<AlarmSetting>(initialAlarm);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [playlistDraftName, setPlaylistDraftName] = useState("");
  const [playlistDraftFileIds, setPlaylistDraftFileIds] = useState<string[]>([]);
  const [isAlarmRinging, setIsAlarmRinging] = useState(false);
  const [playbackState, setPlaybackState] = useState<{ playlistId: string; index: number } | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [needsManualPlay, setNeedsManualPlay] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionUrls = useRef<Record<string, string>>({});
  const mediaElementRef = useRef<HTMLMediaElement | null>(null);

  // Load persisted data once
  useEffect(() => {
    try {
      const savedMedia = localStorage.getItem(MEDIA_KEY);
      const savedPlaylists = localStorage.getItem(PLAYLIST_KEY);
      const savedAlarm = localStorage.getItem(ALARM_KEY);

      if (savedMedia) {
        const parsed: MediaFile[] = JSON.parse(savedMedia);
        setMediaFiles(parsed);
      }
      if (savedPlaylists) {
        const parsed: Playlist[] = JSON.parse(savedPlaylists);
        setPlaylists(parsed);
      }
      if (savedAlarm) {
        const parsed: AlarmSetting = JSON.parse(savedAlarm);
        setAlarm(parsed);
      }
    } catch (error) {
      console.error("Failed to load Rise Beat data", error);
    } finally {
      setHydrated(true);
    }
  }, []);

  // Persist media list
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(MEDIA_KEY, JSON.stringify(mediaFiles));
  }, [mediaFiles, hydrated]);

  // Persist playlists
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(PLAYLIST_KEY, JSON.stringify(playlists));
  }, [playlists, hydrated]);

  // Persist alarm settings
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(ALARM_KEY, JSON.stringify(alarm));
  }, [alarm, hydrated]);

  const clearAlarmTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const computeNextTrigger = useCallback((time: string) => {
    const [hours, minutes] = time.split(":").map((value) => parseInt(value, 10));
    const now = new Date();
    const target = new Date();
    target.setHours(hours, minutes, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime();
  }, []);

  const beginPlayback = useCallback(
    (playlistId: string) => {
      const playlist = playlists.find((item) => item.id === playlistId);
      if (!playlist || playlist.fileIds.length === 0) {
        setStatusMessage("再生できるファイルが見つかりません。");
        return;
      }
      setStatusMessage(null);
      setIsAlarmRinging(true);
      setPlaybackState({ playlistId, index: 0 });
      setNeedsManualPlay(false);
    },
    [playlists],
  );

  const stopPlayback = useCallback(() => {
    if (mediaElementRef.current) {
      mediaElementRef.current.pause();
      mediaElementRef.current.currentTime = 0;
    }
    mediaElementRef.current = null;
    setIsAlarmRinging(false);
    setPlaybackState(null);
    setNeedsManualPlay(false);
  }, []);

  const finishPlayback = useCallback(() => {
    stopPlayback();
    setStatusMessage("プレイリストの再生が完了しました。");
    if (alarm.isOn && alarm.time) {
      const next = computeNextTrigger(alarm.time);
      setAlarm((prev) => ({ ...prev, nextTrigger: next }));
    }
  }, [alarm.isOn, alarm.time, computeNextTrigger, stopPlayback]);

  const advanceTrack = useCallback(
    (nextIndex?: number) => {
      setPlaybackState((prev) => {
        if (!prev) return null;
        const playlist = playlists.find((p) => p.id === prev.playlistId);
        if (!playlist) {
          return null;
        }
        const targetIndex = typeof nextIndex === "number" ? nextIndex : prev.index + 1;
        if (targetIndex >= playlist.fileIds.length) {
          finishPlayback();
          return null;
        }
        return { ...prev, index: targetIndex };
      });
    },
    [finishPlayback, playlists],
  );

  // Schedule alarm firing based on current alarm settings
  useEffect(() => {
    if (!hydrated) return;
    clearAlarmTimeout();

    if (!alarm.isOn || !alarm.time || !alarm.playlistId) {
      if (alarm.nextTrigger) {
        setAlarm((prev) => ({ ...prev, nextTrigger: null }));
      }
      return;
    }

    const now = Date.now();
    const existing = alarm.nextTrigger;
    const nextTarget =
      existing && existing > now ? existing : computeNextTrigger(alarm.time);

    if (nextTarget !== existing) {
      setAlarm((prev) => ({ ...prev, nextTrigger: nextTarget }));
      return;
    }

    const delay = Math.max(nextTarget - now, 0);
    timeoutRef.current = setTimeout(() => {
      beginPlayback(alarm.playlistId!);
      setAlarm((prev) => {
        if (!prev.isOn || !prev.time) {
          return { ...prev, nextTrigger: null };
        }
        const next = computeNextTrigger(prev.time);
        return { ...prev, nextTrigger: next };
      });
    }, delay);

    return () => {
      clearAlarmTimeout();
    };
  }, [
    alarm.isOn,
    alarm.nextTrigger,
    alarm.playlistId,
    alarm.time,
    beginPlayback,
    clearAlarmTimeout,
    computeNextTrigger,
    hydrated,
  ]);

  // Cleanup object URLs on unmount
  useEffect(
    () => () => {
      Object.values(sessionUrls.current).forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  // Ensure alarm references valid playlist data
  useEffect(() => {
    if (!hydrated || !alarm.playlistId) return;
    const target = playlists.find((playlist) => playlist.id === alarm.playlistId);
    if (!target || target.fileIds.length === 0) {
      setAlarm((prev) => {
        if (prev.playlistId !== alarm.playlistId) {
          return prev;
        }
        return { ...prev, playlistId: null, isOn: false, nextTrigger: null };
      });
      clearAlarmTimeout();
      stopPlayback();
    }
  }, [alarm.playlistId, clearAlarmTimeout, hydrated, playlists, stopPlayback]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const additions: MediaFile[] = [];
    Array.from(files).forEach((file) => {
      const mime = file.type;
      const kind: MediaKind = mime.startsWith("video") ? "video" : "audio";
      if (kind === "audio" || kind === "video") {
        const id = crypto.randomUUID();
        additions.push({
          id,
          name: file.name,
          mimeType: mime,
          kind,
          createdAt: Date.now(),
        });
        sessionUrls.current[id] = URL.createObjectURL(file);
      }
    });

    if (additions.length) {
      setMediaFiles((prev) => [...prev, ...additions]);
      setStatusMessage(`${additions.length}件のファイルを読み込みました。`);
    } else {
      setStatusMessage("動画または音声のファイルのみ追加できます。");
    }
    event.target.value = "";
  };

  const handleRemoveMedia = (id: string) => {
    setMediaFiles((prev) => prev.filter((file) => file.id !== id));
    if (sessionUrls.current[id]) {
      URL.revokeObjectURL(sessionUrls.current[id]);
      delete sessionUrls.current[id];
    }
    let alarmPlaylistCleared = false;
    setPlaylists((prev) =>
      prev.map((playlist) => {
        if (!playlist.fileIds.includes(id)) {
          return playlist;
        }
        const nextFileIds = playlist.fileIds.filter((fileId) => fileId !== id);
        if (playlist.id === alarm.playlistId && nextFileIds.length === 0) {
          alarmPlaylistCleared = true;
        }
        return { ...playlist, fileIds: nextFileIds };
      }),
    );
    setPlaylistDraftFileIds((prev) => prev.filter((fileId) => fileId !== id));
    if (alarmPlaylistCleared) {
      setAlarm((prev) => ({ ...prev, playlistId: null, isOn: false, nextTrigger: null }));
      clearAlarmTimeout();
      stopPlayback();
    }
    setStatusMessage("ファイルを削除しました。");
  };

  const handleSelectPlaylist = (playlistId: string | null) => {
    if (!playlistId) {
      setSelectedPlaylistId(null);
      setPlaylistDraftName("");
      setPlaylistDraftFileIds([]);
      return;
    }
    const target = playlists.find((playlist) => playlist.id === playlistId);
    if (!target) return;
    setSelectedPlaylistId(playlistId);
    setPlaylistDraftName(target.name);
    setPlaylistDraftFileIds([...target.fileIds]);
  };

  const handleAddFileToDraft = (fileId: string) => {
    if (!fileId) return;
    const exists = mediaFiles.some((file) => file.id === fileId);
    if (!exists) return;
    setPlaylistDraftFileIds((prev) => [...prev, fileId]);
  };

  const moveDraftItem = (index: number, direction: -1 | 1) => {
    setPlaylistDraftFileIds((prev) => {
      const next = [...prev];
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= next.length) return prev;
      const [item] = next.splice(index, 1);
      next.splice(targetIndex, 0, item);
      return next;
    });
  };

  const removeDraftItem = (index: number) => {
    setPlaylistDraftFileIds((prev) => prev.filter((_, idx) => idx !== index));
  };

  const handleSavePlaylist = () => {
    if (!playlistDraftName.trim()) {
      setStatusMessage("プレイリスト名を入力してください。");
      return;
    }
    if (playlistDraftFileIds.length === 0) {
      setStatusMessage("少なくとも1つファイルを追加してください。");
      return;
    }
    if (selectedPlaylistId) {
      setPlaylists((prev) =>
        prev.map((playlist) =>
          playlist.id === selectedPlaylistId
            ? { ...playlist, name: playlistDraftName.trim(), fileIds: playlistDraftFileIds }
            : playlist,
        ),
      );
      setStatusMessage("プレイリストを更新しました。");
    } else {
      const newPlaylist: Playlist = {
        id: crypto.randomUUID(),
        name: playlistDraftName.trim(),
        fileIds: playlistDraftFileIds,
      };
      setPlaylists((prev) => [...prev, newPlaylist]);
      setSelectedPlaylistId(newPlaylist.id);
      setStatusMessage("プレイリストを保存しました。");
    }
  };

  const handleDeletePlaylist = () => {
    if (!selectedPlaylistId) return;
    const playlist = playlists.find((p) => p.id === selectedPlaylistId);
    if (!playlist) return;
    const ok = window.confirm(`「${playlist.name}」を削除しますか？`);
    if (!ok) return;
    setPlaylists((prev) => prev.filter((p) => p.id !== selectedPlaylistId));
    if (alarm.playlistId === selectedPlaylistId) {
      setAlarm((prev) => ({ ...prev, playlistId: null, isOn: false, nextTrigger: null }));
      clearAlarmTimeout();
      stopPlayback();
    }
    handleSelectPlaylist(null);
    setStatusMessage("プレイリストを削除しました。");
  };

  const updateAlarm = (changes: Partial<AlarmSetting>) => {
    setAlarm((prev) => ({ ...prev, ...changes }));
  };

  const handleToggleAlarm = () => {
    if (alarm.isOn) {
      updateAlarm({ isOn: false, nextTrigger: null });
      clearAlarmTimeout();
      stopPlayback();
      return;
    }
    if (!alarm.time || !alarm.playlistId) {
      setStatusMessage("時刻とプレイリストを選択してください。");
      return;
    }
    const next = computeNextTrigger(alarm.time);
    updateAlarm({ isOn: true, nextTrigger: next });
    setStatusMessage(`アラームをONにしました。次回: ${new Date(next).toLocaleString()}`);
  };

  // Skip files that no longer have an object URL (after reload)
  useEffect(() => {
    if (!playbackState) return;
    const playlist = playlists.find((p) => p.id === playbackState.playlistId);
    if (!playlist) {
      stopPlayback();
      return;
    }
    const fileId = playlist.fileIds[playbackState.index];
    if (!fileId) {
      finishPlayback();
      return;
    }
    if (!sessionUrls.current[fileId]) {
      advanceTrack();
    }
  }, [advanceTrack, finishPlayback, playbackState, playlists, stopPlayback]);

  const currentTrack = useMemo(() => {
    if (!playbackState) return null;
    const playlist = playlists.find((p) => p.id === playbackState.playlistId);
    if (!playlist) return null;
    const fileId = playlist.fileIds[playbackState.index];
    return mediaFiles.find((file) => file.id === fileId) ?? null;
  }, [mediaFiles, playbackState, playlists]);

  const currentTrackUrl = currentTrack ? sessionUrls.current[currentTrack.id] : null;
  const missingObjectUrl = !!currentTrack && !currentTrackUrl;
  const trackIsVideo = currentTrack?.kind === "video";

  const attemptPlay = useCallback(() => {
    const element = mediaElementRef.current;
    if (!element) return;
    const playResult = element.play();
    if (!playResult) return;
    playResult
      .then(() => {
        setNeedsManualPlay(false);
        setStatusMessage(null);
      })
      .catch(() => {
        setNeedsManualPlay(true);
        setStatusMessage("ブラウザの自動再生がブロックされました。下のボタンで再生を開始してください。");
      });
  }, []);

  useEffect(() => {
    if (!currentTrack || missingObjectUrl) {
      setNeedsManualPlay(false);
      return;
    }
    attemptPlay();
  }, [attemptPlay, currentTrack, missingObjectUrl]);

  const nextAlarmDate = alarm.nextTrigger ? new Date(alarm.nextTrigger) : null;

  const playlistNameForAlarm =
    alarm.playlistId ? playlists.find((p) => p.id === alarm.playlistId)?.name ?? "不明" : "未選択";

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-50 to-zinc-100 py-12">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4">
        <header className="text-center">
          <p className="text-sm uppercase tracking-widest text-zinc-500">好きな動画で起きるアラーム</p>
          <h1 className="mt-2 text-4xl font-bold text-zinc-900">Rise Beat</h1>
          <p className="mt-3 text-zinc-600">
            ローカルの動画・音声を読み込んで、朝のテンションを上げるアラームを作りましょう。
          </p>
        </header>

        {statusMessage && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {statusMessage}
          </div>
        )}

        <section className={cardClass}>
          <h2 className={sectionTitleClass}>1. ファイルを読み込む</h2>
          <p className="mt-2 text-sm text-zinc-600">
            ここで読み込んだファイルはブラウザ内でのみ管理され、セッションが変わると再生できなくなります。
          </p>
          <div className="mt-4 flex flex-col gap-4 md:flex-row md:items-center">
            <input
              type="file"
              accept="video/*,audio/*"
              multiple
              onChange={handleFileChange}
              className="w-full rounded-lg border border-dashed border-zinc-300 px-4 py-3 text-sm text-zinc-600"
            />
            <p className="text-xs text-zinc-500 md:w-56">
              ※ 音声/動画ファイルのみ。プレイリストで利用する前に先に読み込んでください。
            </p>
          </div>

          <div className="mt-6">
            <h3 className="text-base font-semibold text-zinc-800">読み込み済みファイル</h3>
            {mediaFiles.length === 0 && (
              <p className="mt-2 text-sm text-zinc-500">まだファイルがありません。</p>
            )}
            <ul className="mt-3 space-y-2">
              {mediaFiles.map((file) => (
                <li
                  key={file.id}
                  className="flex flex-wrap items-center justify-between rounded-xl border border-zinc-200 px-4 py-3"
                >
                  <div>
                    <p className="font-medium text-zinc-900">{file.name}</p>
                    <p className="text-xs text-zinc-500">
                      {file.kind === "video" ? "動画" : "音声"} / {file.mimeType}
                      {!sessionUrls.current[file.id] && (
                        <span className="ml-2 text-rose-500">再生不可 (再度読み込みが必要)</span>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={() => handleRemoveMedia(file.id)}
                    className="mt-2 text-sm text-rose-600 hover:text-rose-700 md:mt-0"
                  >
                    削除
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 className={sectionTitleClass}>2. プレイリストを作成・編集</h2>
            <button
              onClick={() => handleSelectPlaylist(null)}
              className="rounded-full border border-zinc-300 px-4 py-1 text-sm text-zinc-600 transition hover:border-zinc-400"
            >
              新規作成
            </button>
          </div>

          <div className="mt-4 grid gap-6 lg:grid-cols-5">
            <div className="space-y-3 rounded-xl bg-zinc-50 p-4 lg:col-span-2">
              <p className="text-sm font-medium text-zinc-700">既存プレイリスト</p>
              {playlists.length === 0 && (
                <p className="text-sm text-zinc-500">まだ作成されていません。</p>
              )}
              <div className="flex flex-col gap-2">
                {playlists.map((playlist) => (
                  <button
                    key={playlist.id}
                    onClick={() => handleSelectPlaylist(playlist.id)}
                    className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                      playlist.id === selectedPlaylistId
                        ? "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-transparent bg-white text-zinc-700 hover:border-zinc-200"
                    }`}
                  >
                    <span className="font-medium">{playlist.name}</span>
                    <span className="ml-2 text-xs text-zinc-500">{playlist.fileIds.length}件</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="lg:col-span-3">
              <div className="space-y-4">
                <label className="block text-sm font-medium text-zinc-700">
                  プレイリスト名
                  <input
                    value={playlistDraftName}
                    onChange={(event) => setPlaylistDraftName(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                    placeholder="例：朝テンション爆上げ"
                  />
                </label>

                <div className="flex flex-wrap gap-3">
                  <select
                    className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                    onChange={(event) => handleAddFileToDraft(event.target.value)}
                    value=""
                    disabled={mediaFiles.length === 0}
                  >
                    <option value="" disabled>
                      追加するファイルを選択
                    </option>
                    {mediaFiles.map((file) => (
                      <option key={file.id} value={file.id}>
                        {file.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-zinc-500">選択すると末尾に追加されます。</p>
                </div>

                <div>
                  <p className="text-sm font-medium text-zinc-700">収録ファイル（再生順）</p>
                  {playlistDraftFileIds.length === 0 && (
                    <p className="mt-2 text-sm text-zinc-500">ファイルを追加してください。</p>
                  )}
                  <ul className="mt-3 space-y-2">
                    {playlistDraftFileIds.map((fileId, index) => {
                      const file = mediaFiles.find((item) => item.id === fileId);
                      if (!file) return null;
                      return (
                        <li
                          key={`${fileId}-${index}`}
                          className="flex flex-wrap items-center justify-between rounded-xl border border-zinc-200 px-4 py-3 text-sm"
                        >
                          <div>
                            <p className="font-medium text-zinc-900">
                              {index + 1}. {file.name}
                            </p>
                            {!sessionUrls.current[file.id] && (
                              <p className="text-xs text-rose-500">※ このセッションでは再生できません</p>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-xs">
                            <button
                              onClick={() => moveDraftItem(index, -1)}
                              className="rounded-full border border-zinc-300 px-2 py-1 text-zinc-600 disabled:opacity-30"
                              disabled={index === 0}
                            >
                              ↑
                            </button>
                            <button
                              onClick={() => moveDraftItem(index, 1)}
                              className="rounded-full border border-zinc-300 px-2 py-1 text-zinc-600 disabled:opacity-30"
                              disabled={index === playlistDraftFileIds.length - 1}
                            >
                              ↓
                            </button>
                            <button
                              onClick={() => removeDraftItem(index)}
                              className="rounded-full border border-rose-200 px-3 py-1 text-rose-600"
                            >
                              除外
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                <div className="flex flex-wrap gap-3">
                  <button
                    onClick={handleSavePlaylist}
                    className="rounded-full bg-blue-600 px-6 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
                  >
                    プレイリストを保存
                  </button>
                  {selectedPlaylistId && (
                    <button
                      onClick={handleDeletePlaylist}
                      className="rounded-full border border-rose-300 px-6 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-50"
                    >
                      削除
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className={cardClass}>
          <h2 className={sectionTitleClass}>3. アラーム設定</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="block text-sm font-medium text-zinc-700">
              時刻
              <input
                type="time"
                value={alarm.time}
                onChange={(event) => updateAlarm({ time: event.target.value })}
                className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm font-medium text-zinc-700">
              使用するプレイリスト
              <select
                value={alarm.playlistId ?? ""}
                onChange={(event) => updateAlarm({ playlistId: event.target.value || null })}
                className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              >
                <option value="">選択してください</option>
                {playlists.map((playlist) => (
                  <option key={playlist.id} value={playlist.id} disabled={playlist.fileIds.length === 0}>
                    {playlist.name} {playlist.fileIds.length === 0 ? "(ファイルなし)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="mt-4 block text-sm font-medium text-zinc-700">
            タスクメモ
            <textarea
              value={alarm.memo}
              onChange={(event) => updateAlarm({ memo: event.target.value })}
              className="mt-1 min-h-[120px] w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              placeholder="今日のタスクを書き留めておきましょう。"
            />
          </label>

          <div className="mt-4 flex flex-wrap items-center gap-4">
            <button
              onClick={handleToggleAlarm}
              className={`rounded-full px-8 py-3 text-sm font-semibold text-white transition ${
                alarm.isOn ? "bg-rose-500 hover:bg-rose-400" : "bg-emerald-600 hover:bg-emerald-500"
              }`}
            >
              アラームを{alarm.isOn ? "OFF" : "ON"}にする
            </button>
            {alarm.isOn && nextAlarmDate && (
              <p className="text-sm text-zinc-600">
                次のアラーム: {nextAlarmDate.toLocaleString("ja-JP", { hour12: false })}
              </p>
            )}
          </div>
        </section>

        <section className={cardClass}>
          <h2 className={sectionTitleClass}>4. 現在のアラーム / 再生</h2>
          {alarm.isOn ? (
            <div className="mt-3 space-y-2 rounded-xl bg-zinc-50 p-4 text-sm text-zinc-700">
              <p>
                <span className="font-semibold text-zinc-900">次のアラーム:</span>{" "}
                {nextAlarmDate
                  ? nextAlarmDate.toLocaleString("ja-JP", { hour12: false })
                  : "計算中"}
              </p>
              <p>
                <span className="font-semibold text-zinc-900">プレイリスト:</span> {playlistNameForAlarm}
              </p>
              <div>
                <p className="font-semibold text-zinc-900">タスク:</p>
                <pre className="mt-1 whitespace-pre-wrap text-sm">{alarm.memo || "（未入力）"}</pre>
              </div>
            </div>
          ) : (
            <p className="mt-3 rounded-xl bg-zinc-50 p-4 text-sm text-zinc-500">アラームはOFFです。</p>
          )}

          <div className="mt-6 rounded-2xl border border-dashed border-zinc-200 p-4">
            <p className="text-sm font-semibold text-zinc-800">再生ステータス</p>
            {isAlarmRinging && currentTrack ? (
              <div className="mt-3 space-y-3">
                <p className="text-zinc-700">
                  再生中: <span className="font-semibold text-zinc-900">{currentTrack.name}</span>
                </p>
                {missingObjectUrl ? (
                  <p className="text-sm text-rose-500">
                    ファイルを再生できません。もう一度ファイルを読み込んでください。
                  </p>
                ) : trackIsVideo ? (
                  <video
                    key={currentTrack.id}
                    ref={(element) => {
                      mediaElementRef.current = element;
                    }}
                    src={currentTrackUrl ?? ""}
                    className="w-full rounded-xl bg-black"
                    autoPlay
                    onEnded={() => advanceTrack()}
                  />
                ) : (
                  <audio
                    key={currentTrack.id}
                    ref={(element) => {
                      mediaElementRef.current = element;
                    }}
                    src={currentTrackUrl ?? ""}
                    className="w-full"
                    autoPlay
                    onEnded={() => advanceTrack()}
                  />
                )}
                {needsManualPlay && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    <p>ブラウザの自動再生がブロックされました。下のボタンを押して再生を開始してください。</p>
                    <button
                      onClick={attemptPlay}
                      className="mt-3 rounded-full bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-400"
                    >
                      再生を開始する
                    </button>
                  </div>
                )}
                <button
                  onClick={stopPlayback}
                  className="rounded-full bg-rose-600 px-6 py-2 text-sm font-semibold text-white transition hover:bg-rose-500"
                >
                  止める
                </button>
              </div>
            ) : (
              <p className="mt-3 text-sm text-zinc-500">再生しているプレイリストはありません。</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
