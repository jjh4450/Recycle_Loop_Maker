/**
 * 병합 후 스모크 테스트 (헤드리스 Chromium + Vite dev 서버)
 *
 * 검증 경로:
 *  T0 로드/캔버스 렌더   T1 배치·제거 히트테스트   T2 마커 배치·단일성·진행 로직
 *  T3 undo/redo          T4 선택 모드 일괄 변경·이동·삭제
 *  T5 저장               T6 불러오기+그리드 확장   T7 줌/팬/그리드 토글
 *  T8 재생(시작점→중단점, 도돌이표)
 *
 * 주의: 그리드는 화면 중앙 정렬이라 임의 셀은 화면 밖일 수 있음 →
 *       마우스 조작 전 centerOnCell()로 대상 셀을 뷰포트 중앙에 배치.
 *
 * 실행: node tests/smoke.mjs
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const EXE = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = 'http://localhost:5173';
const SHOTS = '/tmp/rl-shots';

const results = [];
const pageErrors = [];
const consoleErrors = [];

function report(name, pass, info = '') {
  results.push({ name, pass, info });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
}

async function waitFor(page, fn, arg, timeout = 5000, label = '') {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await page.evaluate(fn, arg);
    if (last) return last;
    await page.waitForTimeout(100);
  }
  throw new Error(`waitFor timeout${label ? ` (${label})` : ''}: last=${JSON.stringify(last)}`);
}

const browser = await chromium.launch({
  executablePath: EXE,
  args: [
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-dev-shm-usage',
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => {
  if (m.type() === 'error') consoleErrors.push(`${m.text()} @ ${m.location()?.url ?? ''}`);
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

// ───────── 헬퍼 ─────────
const hook = fn => page.evaluate(fn);

// 대상 셀을 뷰포트 중앙으로 (마우스 조작 전 필수 — 그리드가 화면보다 큼)
async function centerOnCell(col, row) {
  await page.evaluate(([c, r]) => {
    const g = window.__recycloop.grid;
    const rect = g.canvas.getBoundingClientRect();
    g._setOffset(
      rect.width / 2 - g.labelWidth - (c + 0.5) * 40 * g.scale,
      rect.height / 2 - (r + 0.5) * 40 * g.scale,
    );
  }, [col, row]);
  await page.waitForTimeout(60);
}

async function cellCenter(col, row) {
  return page.evaluate(([c, r]) => {
    const g = window.__recycloop.grid;
    const rect = g.canvas.getBoundingClientRect();
    return {
      x: rect.left + g.labelWidth + g._offset.x + (c + 0.5) * 40 * g.scale,
      y: rect.top + g._offset.y + (r + 0.5) * 40 * g.scale,
    };
  }, [col, row]);
}

async function clickCell(col, row) {
  await centerOnCell(col, row);
  const p = await cellCenter(col, row);
  await page.mouse.click(p.x, p.y);
}

async function objectCount() {
  return hook(() => window.__recycloop.objects.objects.size);
}

async function selectInstrument(id) {
  await page.click(`.instrument-item[data-id="${id}"]`);
  await page.waitForTimeout(80);
}

async function deselectIfActive() {
  const active = await page.$('.instrument-item.active');
  if (active) { await active.click(); await page.waitForTimeout(80); }
}

async function placeAt(id, col, row) {
  const before = await objectCount();
  await selectInstrument(id);
  await clickCell(col, row);
  await waitFor(page, n => window.__recycloop.objects.objects.size > n, before, 5000, `place ${id} @${col}-${row}`);
  await deselectIfActive();
}

async function ensureSelectionModeOff() {
  await page.evaluate(() => {
    const s = window.__recycloop.selection;
    if (s.isSelectionMode()) s.setSelectionMode(false);
  });
}

async function resetAll() {
  await ensureSelectionModeOff();
  await deselectIfActive();
  await page.click('#btn-reset');
  await waitFor(page, () => window.__recycloop.objects.objects.size === 0, null, 5000, 'reset');
}

// 악기/컨트롤 패널 열기 (이후 내내 열어둠)
await page.click('.floating-panel.left .panel-toggle');
await page.waitForTimeout(450);
await page.click('.floating-panel.right .panel-toggle');
await page.waitForTimeout(450);

// ───────── T0: 로드/캔버스 렌더 ─────────
try {
  const t0 = await hook(() => {
    const g = window.__recycloop?.grid;
    const bg = document.getElementById('grid-bg');
    return {
      hookOk: !!g,
      bgExists: !!bg,
      bgSized: bg && bg.width > 0 && bg.height > 0,
      worldW: g?.world.style.width,
      cols: g?.cols,
    };
  });
  report('T0-1 앱 로드 + 상태 훅', t0.hookOk);
  report('T0-2 배경 캔버스 생성/사이즈', t0.bgExists && t0.bgSized);
  report('T0-3 월드 크기 = cols×40', t0.worldW === `${t0.cols * 40}px`, `cols=${t0.cols}, world=${t0.worldW}`);
  report('T0-4 셀 div 0개 (캔버스 전환 확인)', await hook(() => document.querySelectorAll('.grid-cell').length === 0));

  const panel = await hook(() => ({
    sections: [...document.querySelectorAll('.instrument-category')].map(e => e.textContent),
    items: document.querySelectorAll('.instrument-item').length,
  }));
  report('T0-5 악기 패널 카테고리 섹션', JSON.stringify(panel.sections) === JSON.stringify(['멜로디', '쉼표', '마커']), JSON.stringify(panel.sections));
  report('T0-6 악기 12종 렌더', panel.items === 12, `items=${panel.items}`);

  await page.fill('#instrument-search', '도돌이');
  await page.waitForTimeout(100);
  const search = await hook(() => ({
    visibleItems: [...document.querySelectorAll('.instrument-item:not(.hidden)')].map(e => e.dataset.id),
    visibleSections: [...document.querySelectorAll('.instrument-section:not(.hidden) .instrument-category')].map(e => e.textContent),
  }));
  report('T0-7 패널 검색 필터', JSON.stringify(search.visibleItems) === JSON.stringify(['repeat_start', 'repeat_end']) && JSON.stringify(search.visibleSections) === JSON.stringify(['마커']), JSON.stringify(search));
  await page.fill('#instrument-search', '');
  await page.waitForTimeout(100);

  await page.screenshot({ path: `${SHOTS}/t0-load.png` });
} catch (e) { report('T0 로드', false, e.message); }

// ───────── T1: 배치·제거 히트테스트 ─────────
try {
  await placeAt('blow_bottle', 10, 39);
  const placed = await hook(() => {
    const o = window.__recycloop.objects.objects.get('10-39');
    const g = window.__recycloop.grid;
    return {
      exists: !!o, id: o?.id, note: o?.note,
      occupied: g.isOccupied('10-39'),
      inOccupiedSet: g.occupiedKeys.has('10-39'),
      imgLeft: o?.img.style.left, imgTop: o?.img.style.top,
      inWorld: o?.img.parentElement === g.world,
      byCol: !!window.__recycloop.objects.getByCol(10)?.has('10-39'),
      rowNote: window.__recycloop.grid.getCell('10-39')?.note,
    };
  });
  report('T1-1 좌표 클릭 배치 (10-39)', placed.exists && placed.occupied && placed.inOccupiedSet, JSON.stringify(placed));
  report('T1-2 음높이 매핑 (row39=A4, 위가 고음)', placed.note === 'A4' && placed.rowNote === 'A4', `note=${placed.note}`);
  report('T1-3 월드 좌표 배치 (420px,1580px)', placed.imgLeft === '420px' && placed.imgTop === '1580px' && placed.inWorld, `left=${placed.imgLeft} top=${placed.imgTop}`);
  report('T1-4 컬럼 인덱스 갱신', placed.byCol);

  // 악기 비선택 상태에서 클릭 → 제거
  await clickCell(10, 39);
  await waitFor(page, () => window.__recycloop.objects.objects.size === 0, null, 3000, 'remove');
  const afterRemove = await hook(() => ({
    occupied: window.__recycloop.grid.isOccupied('10-39'),
    occupiedSet: window.__recycloop.grid.occupiedKeys.size,
    imgs: document.querySelectorAll('.placed-object').length,
  }));
  report('T1-5 클릭 제거 + 상태 정리', !afterRemove.occupied && afterRemove.occupiedSet === 0 && afterRemove.imgs === 0, JSON.stringify(afterRemove));
} catch (e) { report('T1 배치/제거', false, e.message); }

// ───────── T2: ① 마커 배치·단일성·진행 로직 ─────────
try {
  await placeAt('marker_start', 4, 39);
  await placeAt('marker_stop', 20, 39);
  const markers = await hook(() => {
    const objs = window.__recycloop.objects;
    return {
      start: objs.objects.get('4-39')?.detail?.marker,
      stop: objs.objects.get('20-39')?.detail?.marker,
      startSvg: objs.objects.get('4-39')?.img.src.endsWith('/img/marker_start.svg'),
    };
  });
  report('T2-1 마커 배치 (시작점/중단점)', markers.start === 'start' && markers.stop === 'stop' && markers.startSvg, JSON.stringify(markers));

  // 마커 교체는 "기존 제거 + 새 배치"라 총 개수가 안 변함 → 키 기준으로 대기
  await selectInstrument('marker_start');
  await clickCell(6, 39);
  await waitFor(page, () =>
    window.__recycloop.objects.objects.get('6-39')?.detail?.marker === 'start',
    null, 5000, 'marker replace @6-39');
  await deselectIfActive();
  const unique = await hook(() => {
    const keys = [...window.__recycloop.objects.objects.entries()]
      .filter(([, o]) => o.detail?.marker === 'start').map(([k]) => k);
    return { keys, oldGone: !window.__recycloop.grid.isOccupied('4-39') };
  });
  report('T2-2 마커 단일성 (재배치 시 기존 제거)', unique.keys.length === 1 && unique.keys[0] === '6-39' && unique.oldGone, JSON.stringify(unique));

  const logic = await page.evaluate(async () => {
    const { advanceColHelper } = await import('/src/playback/helpers/transportHelper.js');
    const mk = over => Object.assign({
      _currentCol: 0, _endCol: 10, _loopStartCol: 0, _repeatTaken: false,
      _repeatStartCol: null, _repeatEndCol: null, _infiniteStartCol: null, _infiniteEndCol: null,
    }, over);
    const r = {};
    let pm = mk({ _currentCol: 5, _repeatStartCol: 2, _repeatEndCol: 5 });
    r.repeatFirst = advanceColHelper(pm);          // 2 (첫 도달: 되감기)
    pm._currentCol = 5;
    r.repeatSecond = advanceColHelper(pm);         // 6 (두 번째: 통과)
    pm = mk({ _currentCol: 7, _infiniteStartCol: 3, _infiniteEndCol: 7 });
    r.inf1 = advanceColHelper(pm); pm._currentCol = 7;
    r.inf2 = advanceColHelper(pm);                 // 3, 3 (무한 되감기)
    pm = mk({ _currentCol: 10, _loopStartCol: 1, _repeatTaken: true });
    r.wrap = advanceColHelper(pm);                 // 1 (타임라인 끝 → 루프 시작)
    r.wrapReset = pm._repeatTaken === false;
    return r;
  });
  const logicOk = logic.repeatFirst === 2 && logic.repeatSecond === 6
    && logic.inf1 === 3 && logic.inf2 === 3 && logic.wrap === 1 && logic.wrapReset;
  report('T2-3 마커 진행 로직 (도돌이/무한/되감기)', logicOk, JSON.stringify(logic));

  await page.screenshot({ path: `${SHOTS}/t2-markers.png` });
  await resetAll();
} catch (e) { report('T2 마커', false, e.message); await resetAll().catch(() => {}); }

// ───────── T3: ③ Ctrl+Z / Ctrl+Y ─────────
try {
  await placeAt('blow_bottle', 8, 39);
  await placeAt('cling_glass', 9, 39);
  report('T3-1 사전 배치 2개', (await objectCount()) === 2);

  await page.keyboard.press('Control+z');
  await waitFor(page, () => window.__recycloop.objects.objects.size === 1, null, 4000, 'undo');
  const afterUndo = await hook(() => ({
    remaining: [...window.__recycloop.objects.objects.keys()],
    occupied9: window.__recycloop.grid.isOccupied('9-39'),
    imgs: document.querySelectorAll('.placed-object').length,
  }));
  report('T3-2 Ctrl+Z 실행 취소', afterUndo.remaining.length === 1 && afterUndo.remaining[0] === '8-39' && !afterUndo.occupied9 && afterUndo.imgs === 1, JSON.stringify(afterUndo));

  await page.keyboard.press('Control+y');
  await waitFor(page, () => window.__recycloop.objects.objects.size === 2, null, 4000, 'redo');
  const afterRedo = await hook(() => ({
    id9: window.__recycloop.objects.objects.get('9-39')?.id,
    occupied9: window.__recycloop.grid.isOccupied('9-39'),
    imgs: document.querySelectorAll('.placed-object').length,
  }));
  report('T3-3 Ctrl+Y 다시 실행', afterRedo.id9 === 'cling_glass' && afterRedo.occupied9 && afterRedo.imgs === 2, JSON.stringify(afterRedo));
  await resetAll();
} catch (e) { report('T3 undo/redo', false, e.message); await resetAll().catch(() => {}); }

// ───────── T4: ④ 선택 모드 — 드래그 선택, 일괄 악기 변경, 이동, 삭제, 일괄 undo ─────────
try {
  await placeAt('blow_bottle', 30, 39);
  await placeAt('blow_bottle', 32, 39);

  await centerOnCell(31, 39); // 선택 영역(29~33열)이 모두 화면 안에 오도록
  await page.keyboard.press('Space');
  await waitFor(page, () => window.__recycloop.selection.isSelectionMode(), null, 2000, 'selection mode');
  report('T4-1 Space 선택 모드 진입', await hook(() =>
    document.getElementById('grid-canvas').classList.contains('selection-mode')));

  // 드래그로 영역 선택 (29,38) → (33,40)
  const p1 = await cellCenter(29, 38);
  const p2 = await cellCenter(33, 40);
  await page.mouse.move(p1.x, p1.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(p1.x + (p2.x - p1.x) * i / 6, p1.y + (p2.y - p1.y) * i / 6);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  const sel = await hook(() => ({
    keys: [...window.__recycloop.selection.selectionState.keys].sort(),
    marks: [...window.__recycloop.grid.marks.selected].sort(),
    styled: document.querySelectorAll('.placed-object.selected-object').length,
  }));
  report('T4-2 드래그 선택 (오브젝트 2개)', JSON.stringify(sel.keys) === JSON.stringify(['30-39', '32-39'])
    && JSON.stringify(sel.marks) === JSON.stringify(['30-39', '32-39']) && sel.styled === 2, JSON.stringify(sel));
  await page.screenshot({ path: `${SHOTS}/t4-selection.png` });

  // 선택 상태에서 악기 클릭 → 일괄 변경
  await selectInstrument('cling_glass');
  await waitFor(page, () => {
    const o = window.__recycloop.objects.objects;
    return o.get('30-39')?.id === 'cling_glass' && o.get('32-39')?.id === 'cling_glass';
  }, null, 5000, 'bulk change');
  const changed = await hook(() => ({
    srcs: ['30-39', '32-39'].map(k => window.__recycloop.objects.objects.get(k)?.img.src.split('/').pop()),
    stillSelected: window.__recycloop.selection.selectionState.keys.size,
  }));
  report('T4-3 일괄 악기 변경 (blow→cling)', changed.srcs.every(s => s === 'cling_glass.png') && changed.stillSelected === 2, JSON.stringify(changed));

  // 선택 블록 드래그 이동 (+2열)
  const from = await cellCenter(30, 39);
  const to = await cellCenter(32, 39);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(from.x + (to.x - from.x) * i / 5, from.y, { steps: 2 });
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await waitFor(page, () => {
    const o = window.__recycloop.objects.objects;
    return o.has('32-39') && o.has('34-39') && !o.has('30-39');
  }, null, 5000, 'selection move');
  report('T4-4 선택 블록 이동 (+2열)', true);

  // Delete 일괄 삭제 → Ctrl+Z 한 번에 복원 (bulk = 단일 undo 단위)
  await page.keyboard.press('Delete');
  await waitFor(page, () => window.__recycloop.objects.objects.size === 0, null, 4000, 'bulk delete');
  report('T4-5 Delete 일괄 삭제', true);

  await page.keyboard.press('Control+z');
  await waitFor(page, () => window.__recycloop.objects.objects.size === 2, null, 4000, 'undo bulk delete');
  const restored = await hook(() => [...window.__recycloop.objects.objects.keys()].sort());
  report('T4-6 일괄 삭제 Ctrl+Z 복원 (단일 undo)', JSON.stringify(restored) === JSON.stringify(['32-39', '34-39']), JSON.stringify(restored));
} catch (e) { report('T4 선택 모드', false, e.message); }
await ensureSelectionModeOff();
await resetAll().catch(() => {});

// ───────── T5: ② 저장 ─────────
try {
  await placeAt('blow_bottle', 3, 39);
  await placeAt('marker_start', 1, 39);
  const downloadP = page.waitForEvent('download', { timeout: 5000 });
  await page.click('#btn-save');
  const download = await downloadP;
  const saved = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  const okName = /^recycloop-\d{8}-\d{6}\.json$/.test(download.suggestedFilename());
  report('T5-1 저장 다운로드 + 파일명', okName, download.suggestedFilename());
  const cells = saved.objects.map(o => o.cell).sort();
  report('T5-2 저장 형식/내용', saved.format === 'recycloop-project' && saved.version === 1
    && JSON.stringify(cells) === JSON.stringify(['1-39', '3-39']) && saved.settings.bpm === 120, JSON.stringify(saved.objects));
  await resetAll();
} catch (e) { report('T5 저장', false, e.message); await resetAll().catch(() => {}); }

// ───────── T6: ② 불러오기 + 그리드 동적 확장 ─────────
try {
  const project = {
    format: 'recycloop-project', version: 1, savedAt: new Date().toISOString(),
    settings: { bpm: 90, subdivision: '8n', volume: -6 },
    objects: [
      { cell: '2-39', id: 'blow_bottle' },
      { cell: '100-41', id: 'cling_glass' },
      { cell: '200-39', id: 'steel_pan' },   // 초기 160열 밖 → 확장 필요
      { cell: '205-39', id: 'marker_stop' },
    ],
  };
  fs.writeFileSync('/tmp/rl-project.json', JSON.stringify(project));
  await page.setInputFiles('#load-file-input', '/tmp/rl-project.json');
  await waitFor(page, () => window.__recycloop.objects.objects.size === 4, null, 8000, 'load');

  const loaded = await hook(() => {
    const g = window.__recycloop.grid;
    const o = window.__recycloop.objects.objects;
    return {
      cols: g.cols,
      worldW: g.world.style.width,
      cellStateAt200: !!g.getCell('200-39'),
      steelPlaced: o.get('200-39')?.id,
      imgLeft200: o.get('200-39')?.img.style.left,
      bpmLabel: document.getElementById('bpm-label').textContent,
      bpmValue: document.getElementById('btn-bpm').value,
      subChecked: document.querySelector('input[name="sub"]:checked')?.value,
      volumeLabel: document.getElementById('volume-label').textContent,
      occupiedCount: g.occupiedKeys.size,
    };
  });
  report('T6-1 불러오기 4개 배치', loaded.steelPlaced === 'steel_pan' && loaded.occupiedCount === 4, JSON.stringify(loaded));
  report('T6-2 그리드 동적 확장 (160→' + loaded.cols + ')', loaded.cols >= 238 && loaded.worldW === `${loaded.cols * 40}px`, `cols=${loaded.cols}, world=${loaded.worldW}`);
  report('T6-3 확장 영역 셀 상태 + 월드 좌표 배치', loaded.cellStateAt200 && loaded.imgLeft200 === `${200 * 40 + 20}px`, `left=${loaded.imgLeft200}`);
  report('T6-4 설정 복원 (BPM/분할/볼륨 UI)', loaded.bpmLabel === '90 BPM' && loaded.bpmValue === '90'
    && loaded.subChecked === '8n' && loaded.volumeLabel === '-6 dB', JSON.stringify({ b: loaded.bpmLabel, s: loaded.subChecked, v: loaded.volumeLabel }));

  // 확장 영역으로 이동해 시각 확인 (셀 상태·이미지가 정상 렌더되는지)
  await centerOnCell(200, 39);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/t6-expanded-col200.png` });

  await page.keyboard.press('Control+z');
  await waitFor(page, () => window.__recycloop.objects.objects.size === 0, null, 4000, 'undo load');
  report('T6-5 불러오기 Ctrl+Z (단일 undo 단위)', true);
  await page.keyboard.press('Control+y');
  await waitFor(page, () => window.__recycloop.objects.objects.size === 4, null, 4000, 'redo load');
  report('T6-6 불러오기 Ctrl+Y 복원', true);

  fs.writeFileSync('/tmp/rl-bad.json', JSON.stringify({ hello: 'world' }));
  await page.setInputFiles('#load-file-input', '/tmp/rl-bad.json');
  await page.waitForTimeout(400);
  report('T6-7 형식 오류 파일 거부 (상태 유지)', (await objectCount()) === 4);
} catch (e) { report('T6 불러오기/확장', false, e.message); }

// ───────── T7: 줌/팬/그리드 토글 + 줌 상태 히트테스트 ─────────
try {
  await ensureSelectionModeOff();
  await centerOnCell(100, 41);
  const before = await hook(() => ({ ...window.__recycloop.grid._offset }));
  await page.mouse.move(700, 200);
  await page.mouse.down();
  await page.mouse.move(300, 200, { steps: 8 });
  await page.mouse.up();
  const after = await hook(() => ({ ...window.__recycloop.grid._offset }));
  report('T7-1 마우스 팬', Math.round(before.x - after.x) === 400, `Δx=${before.x - after.x}`);

  await page.mouse.move(700, 450);
  await page.mouse.wheel(0, 120);
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(150);
  const scale = await hook(() => window.__recycloop.grid.scale);
  report('T7-2 휠 줌아웃 (1.0→0.8)', Math.abs(scale - 0.8) < 1e-9, `scale=${scale}`);

  // 줌 상태에서 좌표 히트테스트로 배치 (좌표계 일치 검증)
  await placeAt('rest', 50, 30);
  report('T7-3 줌 상태 히트테스트 배치 (50-30)', await hook(() => window.__recycloop.objects.objects.has('50-30')));
  await page.screenshot({ path: `${SHOTS}/t7-zoomed.png` });

  await page.click('#btn-grid');
  await page.waitForTimeout(150);
  const toggled = await hook(() => ({
    flag: window.__recycloop.grid.showGridLines,
    label: document.getElementById('btn-grid').textContent,
  }));
  report('T7-4 그리드 끄기 토글', toggled.flag === false && toggled.label === '그리드 켜기', JSON.stringify(toggled));
  await page.screenshot({ path: `${SHOTS}/t7-grid-off.png` });
  await page.click('#btn-grid');
  await page.waitForTimeout(150);
  report('T7-5 그리드 다시 켜기', await hook(() => window.__recycloop.grid.showGridLines === true));

  // 스케일 복원
  await hook(() => window.__recycloop.grid.setZoom(1));
} catch (e) { report('T7 줌/팬/토글', false, e.message); }

// ───────── T8: ① 재생 — 시작점에서 출발, 중단점에서 정지, 도돌이표 ─────────
try {
  await resetAll();
  // 배치: 시작점 col4, 악기 col5·col8, 중단점 col12 (120BPM·16n → 1초 구간)
  await placeAt('marker_start', 4, 39);
  await placeAt('blow_bottle', 5, 39);
  await placeAt('blow_bottle', 8, 43);
  await placeAt('marker_stop', 12, 39);

  await page.click('#btn-play');
  await waitFor(page, () => document.getElementById('btn-play').classList.contains('playing'), null, 10000, 'playing state');
  const startState = await hook(() => {
    const p = window.__recycloop.playback;
    return {
      transport: p._Tone?.getTransport().state,
      startCol: p._startCol,
      breakpoint: p._breakpointCol,
      audioCtx: p._Tone?.getContext().state,
      samplers: [...p._samplers.keys()],
    };
  });
  report('T8-1 재생 시작 (Tone transport)', startState.transport === 'started' && startState.audioCtx === 'running', JSON.stringify(startState));
  report('T8-2 시작점 마커 반영 (_startCol=4)', startState.startCol === 4, `startCol=${startState.startCol}`);
  report('T8-3 중단점 인식 (_breakpointCol=12)', startState.breakpoint === 12);
  // 샘플러는 악기 id당 1개 (셀당 X) — blow_bottle 2개 배치에도 샘플러는 1개여야 함
  report('T8-4 악기별 샘플러 공유 (blow_bottle 2개 배치→1개)',
    startState.samplers.filter(s => s === 'blow_bottle').length === 1, JSON.stringify(startState.samplers));

  await waitFor(page, () => !document.getElementById('btn-play').classList.contains('playing'), null, 15000, 'auto stop at breakpoint');
  const stopped = await hook(() => ({
    transport: window.__recycloop.playback._Tone.getTransport().state,
    playhead: document.getElementById('playhead').style.transform,
    icon: document.getElementById('play-icon').textContent,
  }));
  report('T8-5 중단점 자동 정지', stopped.transport === 'stopped' && stopped.icon === '▶', JSON.stringify(stopped));
  report('T8-6 플레이헤드 중단점 유지 (480px)', stopped.playhead.includes('480px'), stopped.playhead);
  await centerOnCell(8, 41);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/t8-stopped-at-breakpoint.png` });

  // 도돌이표 재생: col9 도달 시 col6으로 1회 되감기 후 통과
  await resetAll();
  await placeAt('blow_bottle', 5, 39);
  await placeAt('repeat_start', 6, 41);
  await placeAt('repeat_end', 9, 41);
  await placeAt('blow_bottle', 10, 43);
  await hook(() => {
    const p = window.__recycloop.playback;
    window.__cols = [];
    const orig = p._movePlayhead.bind(p);
    p._movePlayhead = col => { window.__cols.push(col); orig(col); };
  });
  await page.click('#btn-play');
  await waitFor(page, () => document.getElementById('btn-play').classList.contains('playing'), null, 10000, 'repeat play');
  // 되감기(9→6)와 두 번째 통과(9→10)가 모두 기록될 때까지 재생 유지
  // (헤드리스 rAF 스로틀로 플레이헤드 기록이 오디오보다 늦을 수 있음)
  const seq = await waitFor(page, () => {
    const s = window.__cols.join(',');
    return s.includes('9,6') && s.includes('9,10') ? s : false;
  }, null, 15000, 'repeat rewind + pass-through');
  await page.click('#btn-play');
  await waitFor(page, () => !document.getElementById('btn-play').classList.contains('playing'), null, 10000, 'stop');
  report('T8-7 도돌이표 재생 (9→6 1회 되감기 후 통과)', true, seq);
} catch (e) { report('T8 재생', false, e.message); }

// ───────── T10: WAV 내보내기 (오프라인 렌더) ─────────
try {
  await resetAll();
  await placeAt('marker_start', 1, 39); // 마커는 소리 없이 시작점만
  await placeAt('blow_bottle', 2, 39);
  await placeAt('blow_bottle', 5, 43);

  // (a) 앱 내부 오프라인 렌더 → 실제 오디오(비무음)인지 채널 데이터로 확인
  const render = await page.evaluate(async () => {
    const mod = await import('/src/io/wavExport.js');
    const { playback, objects } = window.__recycloop;
    const buf = await mod.renderProjectToBuffer(playback, objects);
    const ch = buf.getChannelData(0);
    let peak = 0, nonzero = 0;
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
      if (a > 1e-4) nonzero++;
    }
    return { duration: buf.duration, sampleRate: buf.sampleRate, channels: buf.numberOfChannels, peak, nonzeroRatio: nonzero / ch.length };
  });
  report('T10-1 오프라인 렌더 버퍼 (44.1k/스테레오)', render.duration > 1.5 && render.sampleRate === 44100 && render.channels === 2, JSON.stringify({ d: +render.duration.toFixed(2), sr: render.sampleRate, ch: render.channels }));
  report('T10-2 실제 오디오 렌더 (비무음)', render.peak > 0.01 && render.nonzeroRatio > 0.01, `peak=${render.peak.toFixed(3)}, nonzero=${(render.nonzeroRatio * 100).toFixed(1)}%`);

  // (b) 버튼 클릭 → WAV 파일 다운로드 + 헤더/파일명 검증
  const downloadP = page.waitForEvent('download', { timeout: 30000 });
  await page.click('#btn-export');
  const download = await downloadP;
  const bytes = fs.readFileSync(await download.path());
  const okName = /^recycloop-\d{8}-\d{6}\.wav$/.test(download.suggestedFilename());
  const riff = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
  report('T10-3 WAV 다운로드 + 파일명', okName, download.suggestedFilename());
  report('T10-4 WAV 헤더(RIFF/WAVE) + 크기', riff && bytes.length > 44 + 1000, `bytes=${bytes.length}, riff=${riff}`);
  report('T10-5 버튼 상태 복구 (재활성화)', await hook(() => {
    const b = document.getElementById('btn-export');
    return !b.disabled && b.textContent === 'WAV 내보내기';
  }));

  // (c) 소리 없는 프로젝트(마커만) → 명확한 에러
  await resetAll();
  await placeAt('marker_start', 1, 39);
  const emptyErr = await page.evaluate(async () => {
    const mod = await import('/src/io/wavExport.js');
    const { playback, objects } = window.__recycloop;
    try { await mod.renderProjectToBuffer(playback, objects); return 'no-error'; }
    catch (e) { return e.message; }
  });
  report('T10-6 소리없는 프로젝트 거부', emptyErr.includes('악기가 없습니다'), emptyErr);

  // (d) buildColumnTimeline: 무한반복도 유한하게 종료되는지 (export 핵심 안전장치)
  const finite = await page.evaluate(async () => {
    const mod = await import('/src/io/wavExport.js');
    const tl = mod.buildColumnTimeline({ loopStart: 0, loopEnd: 8, breakpoint: null, repeatStart: null, repeatEnd: null, infiniteStart: 2, infiniteEnd: 5 });
    return { len: tl.length, last: tl[tl.length - 1], seq: tl.join(',') };
  });
  // 0,1,2,3,4,5,→2,3,4,5,6,7,8 : 무한반복 1회만 반영 후 끝까지 진행
  report('T10-7 무한반복 유한 종료 (export)', finite.last === 8 && finite.len < 50 && finite.seq === '0,1,2,3,4,5,2,3,4,5,6,7,8', JSON.stringify(finite));

  await resetAll();
} catch (e) { report('T10 WAV 내보내기', false, e.message); await resetAll().catch(() => {}); }

// ───────── 마무리: 에러 수집 ─────────
const ignorable = /Autoplay|AudioContext was not allowed|favicon\.ico/i;
const realConsoleErrors = consoleErrors.filter(t => !ignorable.test(t));
report('T9-1 페이지 예외 0건', pageErrors.length === 0, pageErrors.join(' | ') || 'none');
report('T9-2 콘솔 에러 0건 (favicon 제외)', realConsoleErrors.length === 0, realConsoleErrors.join(' | ') || 'none');

await browser.close();

const failed = results.filter(r => !r.pass);
console.log(`\n========== 결과: ${results.length - failed.length}/${results.length} 통과 ==========`);
if (failed.length) {
  console.log('실패 목록:');
  failed.forEach(f => console.log(`  ✗ ${f.name} — ${f.info}`));
  process.exit(1);
}
