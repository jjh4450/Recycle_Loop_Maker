import { saveAs } from 'file-saver';
import { showToast } from '../Toast.js';
import { serializeProject, parseProject, makeProjectFileName } from '../../io/projectIO.js';
import { exportProjectToWav } from '../../io/wavExport.js';

export function setupPlaybackControls(playback, objects) {
  const playBtn = document.getElementById('btn-play');
  playBtn?.addEventListener('click', () => {
    const playable = objects.getAll().filter(([, obj]) => !obj.detail?.marker);
    if (playable.length === 0) {
      showToast('배치된 오브젝트가 없습니다. 먼저 악기를 배치해주세요.');
      return;
    }

    // 버튼 상태는 아래 setPlaybackStateCallback에서 갱신됩니다.
    playback.toggle(objects);
  });

  const bpmInput = document.getElementById('btn-bpm');
  const bpmLabel = document.getElementById('bpm-label');
  bpmInput?.addEventListener('input', e => {
    const bpm = parseInt(e.target.value, 10);
    playback.setBpm(bpm);
    if (bpmLabel) bpmLabel.textContent = `${bpm} BPM`;
  });

  const volumeInput = document.getElementById('btn-volume');
  const volumeLabel = document.getElementById('volume-label');
  volumeInput?.addEventListener('input', e => {
    const volume = parseInt(e.target.value, 10);
    playback.setVolume?.(volume);
    if (volumeLabel) volumeLabel.textContent = `${volume} dB`;
  });

  playback.setPlaybackStateCallback?.((state) => {
    const isPlaying = state === 'started';
    playBtn?.classList.toggle('playing', isPlaying);
    document.getElementById('play-icon').textContent = isPlaying ? '⏹' : '▶';
  });
}

// 불러오기 시 한 번에 배치하는 오브젝트 수. 이 수만큼 처리한 뒤
// 프레임에 양보해 브라우저가 그리기·입력 처리를 할 수 있게 합니다.
const LOAD_CHUNK_SIZE = 60;

function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

export function setupFileControls(playback, objects, selection, grid, clearInstrumentState = () => {}) {
  const saveBtn = document.getElementById('btn-save');
  const loadBtn = document.getElementById('btn-load');
  const resetBtn = document.getElementById('btn-reset');
  const loadInput = document.getElementById('load-file-input');

  saveBtn?.addEventListener('click', () => {
    const project = serializeProject(playback, objects);
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    saveAs(blob, makeProjectFileName());
    showToast(`저장 완료 (오브젝트 ${project.objects.length}개)`);
  });

  loadBtn?.addEventListener('click', () => {
    loadInput?.click();
  });

  let loading = false;
  loadInput?.addEventListener('change', async () => {
    const file = loadInput.files?.[0];
    loadInput.value = '';
    if (!file || loading) return;

    let project;
    try {
      project = parseProject(await file.text());
    } catch (err) {
      showToast(err.message ?? '불러오기에 실패했습니다.');
      return;
    }

    loading = true;
    try {
      playback.stop();
      selection.reset();
      clearInstrumentState();
      applyProjectSettings(project, playback, grid, objects);

      // 가장 오른쪽 오브젝트 + 배치 버퍼까지 한 번에 확장 (루프 도중 확장 방지)
      const maxCol = project.objects.reduce((max, { cell }) => {
        const col = parseInt(cell.split('-')[0], 10);
        return Number.isInteger(col) && col > max ? col : max;
      }, 0);
      grid.ensureColumnsForPlacement(maxCol);

      // 불러오기 전체를 한 번의 undo 단위 + 한 번의 렌더 갱신으로 묶고,
      // 청크마다 프레임에 양보해 브라우저가 멈추지 않게 합니다.
      objects.beginBulk();
      try {
        objects.reset();
        const items = project.objects;
        for (let i = 0; i < items.length; i += 1) {
          const { cell, id } = items[i];
          if (grid.getCell(cell)) await objects.place(id, cell);
          if ((i + 1) % LOAD_CHUNK_SIZE === 0 && i + 1 < items.length) {
            showToast(`불러오는 중... ${i + 1}/${items.length}`);
            await nextFrame();
          }
        }
      } finally {
        objects.endBulk();
      }

      showToast(`불러오기 완료 (오브젝트 ${objects.getAll().length}개)`);
    } finally {
      loading = false;
    }
  });

  resetBtn?.addEventListener('click', () => {
    playback.stop();
    objects.reset();
    selection.reset();
    clearInstrumentState();
  });

  const exportBtn = document.getElementById('btn-export');
  let exporting = false;
  exportBtn?.addEventListener('click', async () => {
    if (exporting) return;
    exporting = true;
    playback.stop(); // 실시간 재생과 오프라인 렌더가 겹치지 않게 정지
    const prevLabel = exportBtn.textContent;
    exportBtn.disabled = true;
    exportBtn.textContent = '렌더링 중...';
    showToast('WAV 렌더링 중...');
    try {
      const { fileName, seconds } = await exportProjectToWav(playback, objects);
      showToast(`WAV 내보내기 완료 (${seconds.toFixed(1)}초) — ${fileName}`);
    } catch (err) {
      console.error('WAV 내보내기 실패:', err);
      showToast(err.message ?? 'WAV 내보내기에 실패했습니다.');
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = prevLabel;
      exporting = false;
    }
  });
}

function applyProjectSettings(project, playback, grid, objects) {
  if (project.bpm !== null) {
    playback.setBpm(project.bpm);
    const bpmInput = document.getElementById('btn-bpm');
    const bpmLabel = document.getElementById('bpm-label');
    if (bpmInput) bpmInput.value = project.bpm;
    if (bpmLabel) bpmLabel.textContent = `${project.bpm} BPM`;
  }

  if (project.volume !== null) {
    playback.setVolume?.(project.volume);
    const volumeInput = document.getElementById('btn-volume');
    const volumeLabel = document.getElementById('volume-label');
    if (volumeInput) volumeInput.value = project.volume;
    if (volumeLabel) volumeLabel.textContent = `${project.volume} dB`;
  }

  if (project.subdivision !== null) {
    playback.setSubdivision(project.subdivision);
    grid.setSubdivision(project.subdivision);
    objects.refreshDurationLines?.();
    const radio = document.querySelector(`input[name="sub"][value="${project.subdivision}"]`);
    if (radio) radio.checked = true;
  }
}
