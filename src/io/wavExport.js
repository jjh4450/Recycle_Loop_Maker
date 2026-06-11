import wav from 'audiobuffer-to-wav';
import { saveAs } from 'file-saver';
import { loadTone } from '../playback/helpers/toneLoader.js';
import { computeRange } from '../playback/helpers/rangeHelper.js';
import { getMeasureInterval } from '../grid/helpers/subdivisionHelper.js';

// 비정상 입력(거대한 무한반복 등)으로 렌더가 폭주하지 않도록 한 곡 길이를 제한
const MAX_RENDER_SECONDS = 600; // 10분
const RENDER_SAMPLE_RATE = 44100;
const RENDER_CHANNELS = 2;
// 마지막 음의 릴리스가 잘리지 않도록 타임라인 뒤에 붙이는 여유 시간
const RELEASE_TAIL = 0.4;

/**
 * 재생 마커를 해석해 "한 곡"에 해당하는 유한한 열(column) 시퀀스를 만듭니다.
 * 실시간 advanceColHelper와 같은 우선순위(무한반복 > 도돌이표 > 타임라인 끝)를
 * 따르되, 내보내기는 무한 루프가 없어야 하므로 무한 도돌이표도 1회만 반영하고
 * 타임라인 끝(또는 중단점)에서 종료합니다.
 *
 * @param {ReturnType<typeof computeRange>} range
 * @returns {number[]} 재생 순서대로의 열 인덱스
 */
export function buildColumnTimeline(range) {
  const { loopStart, loopEnd, breakpoint, repeatStart, repeatEnd, infiniteStart, infiniteEnd } = range;
  const cols = [];
  let col = loopStart;
  let repeatTaken = false;
  let infiniteTaken = false;
  // loopEnd - loopStart 한 바퀴 + 도돌이표/무한 1회 되감기를 모두 담아도 남는 상한
  const guard = (loopEnd - loopStart + 2) * 3 + 8;

  while (cols.length < guard) {
    cols.push(col);
    if (breakpoint !== null && col === breakpoint) break;
    if (infiniteEnd !== null && col === infiniteEnd && !infiniteTaken) {
      infiniteTaken = true; col = infiniteStart; continue;
    }
    if (repeatEnd !== null && col === repeatEnd && !repeatTaken) {
      repeatTaken = true; col = repeatStart; continue;
    }
    if (col >= loopEnd) break;
    col += 1;
  }
  return cols;
}

function makeWavFileName(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `recycloop-${stamp}.wav`;
}

/**
 * 현재 배치 상태를 오프라인으로 렌더해 WAV AudioBuffer를 만듭니다.
 * 실시간 재생과 같은 샘플러/음높이/마커 해석을 쓰되, Tone.Offline 안에서
 * 실시간보다 빠르게 한 번에 렌더링합니다.
 *
 * @param {PlaybackManager} playback
 * @param {ObjectManager} objects
 * @returns {Promise<AudioBuffer>}
 */
export async function renderProjectToBuffer(playback, objects) {
  // 소리가 나는 악기만 모음 (마커·쉼표 등 sample 없는 항목 제외)
  const playable = [...objects.objects.values()].filter(
    obj => !obj.detail?.marker && obj.detail?.sample?.notes && obj.note,
  );
  if (playable.length === 0) {
    throw new Error('소리가 나는 악기가 없습니다. 먼저 악기를 배치해주세요.');
  }

  const range = computeRange(playback, objects);
  if (!range) {
    throw new Error('내보낼 재생 범위가 없습니다.');
  }

  const Tone = await loadTone(playback);
  const interval = getMeasureInterval(playback.subdivision);
  const secondsPerColumn = (60 / playback.bpm) * (4 / interval);
  const timeline = buildColumnTimeline(range);

  const maxDuration = playable.reduce((m, obj) => Math.max(m, obj.detail.duration ?? 1), 1);
  const totalSeconds = Math.min(
    timeline.length * secondsPerColumn + maxDuration + RELEASE_TAIL,
    MAX_RENDER_SECONDS,
  );

  // 악기 id별로 필요한 샘플 정의를 모음 (동일 악기는 한 샘플러로 공유)
  const detailsById = new Map();
  playable.forEach(obj => { if (!detailsById.has(obj.id)) detailsById.set(obj.id, obj.detail); });

  const toneBuffer = await Tone.Offline(async () => {
    Tone.getDestination().volume.value = playback.masterVolume;

    const samplers = new Map();
    for (const [id, detail] of detailsById) {
      samplers.set(id, new Tone.Sampler({
        urls: detail.sample.notes,
        volume: detail.volume ?? 0,
      }).toDestination());
    }
    await Tone.loaded(); // 모든 샘플 버퍼 디코딩 대기

    timeline.forEach((col, i) => {
      const bucket = objects.getByCol(col);
      if (!bucket) return;
      const time = i * secondsPerColumn;
      bucket.forEach(obj => {
        if (obj.detail?.marker || !obj.note) return;
        const sampler = samplers.get(obj.id);
        if (sampler) sampler.triggerAttackRelease(obj.note, obj.detail.duration ?? 1, time);
      });
    });
  }, totalSeconds, RENDER_CHANNELS, RENDER_SAMPLE_RATE);

  const audioBuffer = toneBuffer.get();
  if (!audioBuffer) throw new Error('오디오 렌더링에 실패했습니다.');
  return audioBuffer;
}

/**
 * 현재 배치 상태를 WAV로 렌더해 파일로 저장합니다.
 *
 * @param {PlaybackManager} playback
 * @param {ObjectManager} objects
 * @returns {Promise<{ fileName: string, seconds: number }>}
 */
export async function exportProjectToWav(playback, objects) {
  const audioBuffer = await renderProjectToBuffer(playback, objects);
  const wavData = wav(audioBuffer, { float32: false });
  const blob = new Blob([wavData], { type: 'audio/wav' });
  const fileName = makeWavFileName();
  saveAs(blob, fileName);
  return { fileName, seconds: audioBuffer.duration };
}
