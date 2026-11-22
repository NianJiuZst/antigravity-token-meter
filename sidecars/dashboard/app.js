(() => {
  const POLL_MS = 3000;
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const params = new URLSearchParams(location.search);
  let savedCardOpen = true;
  try {
    const raw = localStorage.getItem('tm_live_card_open');
    if (raw === '0') savedCardOpen = false;
  } catch {
    // ignore storage errors in restricted contexts
  }

  const state = {
    days: 7,
    metric: 'cost', // 'cost' | 'tokens'
    tab: 'overview',
    etag: '',
    report: null,
    selectedDate: null,
    sessionSearch: '',
    sessionSort: 'cost',
    liveCardOpen: savedCardOpen,
    liveConvId: '',
    selectedTurnIdx: null, // null => auto-follow latest turn
    pollTimer: null,
    toastTimer: null,
  };

  const clientTimeZone = () => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      return '';
    }
  };

  // ---------- Host theme sync ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- API helpers ----------
  const activeConvId = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  async function apiFetch(path, opts = {}) {
    const fn = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await fn(path, opts);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res;
  }

  async function getJson(path) {
    const res = await apiFetch(path, { method: 'GET' });
    return res.json();
  }

  async function postJson(path, body) {
    const res = await apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  // ---------- Formatters ----------
  function fmtCompact(n) {
    const v = Number(n) || 0;
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return String(Math.round(v));
  }

  function fmtInt(n) {
    return Math.round(Number(n) || 0).toLocaleString('en-US');
  }

  function fmtPct(ratio) {
    return `${((Number(ratio) || 0) * 100).toFixed(1)}%`;
  }

  function currencyMeta(prefs) {
    const isCny = prefs?.currency === 'CNY';
    return {
      code: isCny ? 'CNY' : 'USD',
      sym: isCny ? '¥' : '$',
      mult: isCny ? Number(prefs?.cnyRate) || 7.25 : 1,
    };
  }

  function fmtMoney(usd, prefs, compact = false) {
    const { sym, mult } = currencyMeta(prefs);
    const val = (Number(usd) || 0) * mult;
    if (compact && val >= 1000) return `${sym}${(val / 1000).toFixed(1)}k`;
    if (val >= 100) return `${sym}${val.toFixed(1)}`;
    if (val >= 1) return `${sym}${val.toFixed(2)}`;
    if (val >= 0.01) return `${sym}${val.toFixed(3)}`;
    if (val === 0) return `${sym}0.00`;
    return `${sym}${val.toFixed(4)}`;
  }

  function fmtRelTime(ts) {
    if (!ts) return '';
    const diff = Math.max(0, Date.now() - ts);
    const min = Math.floor(diff / 60_000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
  }

  function fmtWindow(tokens) {
    const n = Number(tokens) || 0;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
    return String(n);
  }

  function fmtDuration(sec) {
    const s = Number(sec) || 0;
    if (s <= 0) return '—';
    if (s < 60) return `${s.toFixed(1)}s`;
    if (s < 3600) return `${s.toFixed(1)}s`;
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    return `${hrs}h ${mins}m`;
  }

  function renderLiveConversation(report) {
    const box = $('live-turn-box');
    const live = report.liveConversation;
    if (!live || !Array.isArray(live.turns) || live.turns.length === 0) {
      box.classList.add('hidden');
      return;
    }

    if (live.convId !== state.liveConvId) {
      state.liveConvId = live.convId;
      state.selectedTurnIdx = null;
    }

    const totalTurns = live.turns.length;
    const isAutoLatest = state.selectedTurnIdx === null || state.selectedTurnIdx >= totalTurns;
    const idx = isAutoLatest ? totalTurns - 1 : Math.max(0, state.selectedTurnIdx - 1);
    const turn = live.turns[idx];
    const sess = live.session;

    box.classList.remove('hidden');

    const hasTurnDecode = turn.tpsMode === 'decode' && turn.tps > 0;
    const hasSessDecode = sess.tpsMode === 'decode' && sess.tps > 0;
    const hasTurnLlm = turn.tps > 0;
    let displayTpsNum = 0;
    let tpsScope = '会话模型';
    if (hasTurnDecode) {
      displayTpsNum = turn.tps;
      tpsScope = turn.avgTtftSec > 0 ? `本轮解码 · 首字 ${fmtDuration(turn.avgTtftSec)}` : '本轮解码';
    } else if (hasSessDecode) {
      displayTpsNum = sess.tps;
      tpsScope = turn.avgTtftSec > 0 ? `会话解码 · 首字 ${fmtDuration(turn.avgTtftSec)}` : '会话解码';
    } else if (hasTurnLlm) {
      displayTpsNum = turn.tps;
      tpsScope = '本轮模型';
    } else {
      displayTpsNum = sess.tps;
      tpsScope = '会话模型';
    }
    const tpsVal = displayTpsNum > 0 ? `${displayTpsNum.toFixed(1)} tok/s` : '—';
    const sessTpsVal = sess.tps > 0 ? `${sess.tps.toFixed(1)} tok/s` : '—';
    const barParts = [
      `<span class="live-bar-model">${esc(turn.modelLabel)}</span>`,
      `<span class="live-bar-stat">In ${esc(fmtCompact(turn.totalInput))}</span>`,
      `<span class="live-bar-stat">Out ${esc(fmtCompact(turn.output))}</span>`,
      `<span class="live-bar-stat">Cache ${esc(fmtPct(turn.cacheHitRate))}</span>`,
      ...(displayTpsNum > 0 ? [`<span class="live-bar-stat">${esc(tpsVal)}</span>`] : []),
    ];
    $('live-turn-bar-text').innerHTML = barParts.join('<span class="live-bar-dot">·</span>');

    const toggleBtn = $('live-turn-toggle');
    const cardEl = $('live-turn-card');
    toggleBtn.setAttribute('aria-expanded', String(state.liveCardOpen));
    cardEl.classList.toggle('hidden', !state.liveCardOpen);

    const ctxPctNum = Math.round((turn.contextPct || 0) * 100);
    const ctxBarW = Math.min(100, Math.max(0, ctxPctNum));
    const ctxClass = ctxPctNum >= 90 ? ' danger' : ctxPctNum >= 75 ? ' warn' : '';
    const durSec = turn.durationSec > 0 ? turn.durationSec : sess.durationSec;
    const durPrefix = turn.durationSec > 0 ? '总时长' : '会话总时长';
    const durBreakdown =
      turn.llmDurationSec > 0 && turn.toolDurationSec > 0
        ? ` <span class="live-row-muted">(模型 ${esc(fmtDuration(turn.llmDurationSec))} · 工具 ${esc(fmtDuration(turn.toolDurationSec))})</span>`
        : '';
    const speedModeNote =
      hasTurnDecode || hasSessDecode
        ? `纯解码速度（已扣除首字等待 TTFT 与工具耗时，过滤突发包）· 本轮平均首字 ${fmtDuration(turn.avgTtftSec)}`
        : '模型推理速度含首字/思考延迟（已剔除工具与审批等待）';
    const durTip =
      `${speedModeNote}` +
      ` · 本轮模型 ${fmtDuration(turn.llmDurationSec)} / 工具 ${fmtDuration(turn.toolDurationSec)}` +
      ` · 会话均速 ${sessTpsVal}${sess.avgTtftSec > 0 ? `（平均首字 ${fmtDuration(sess.avgTtftSec)}）` : ''}` +
      ` · 累计活跃 ${fmtDuration(sess.durationSec)}，共 ${fmtInt(sess.output)} 输出 Token`;
    const turnCostStr = fmtMoney(turn.costUsd, report.prefs);

    const pagerHtml =
      totalTurns > 1
        ? `
        <span class="turn-pager" title="${esc(turn.prompt || `第 ${turn.turnIndex} 轮`)}">
          <button type="button" class="turn-nav-btn" data-turn-nav="-1" ${idx === 0 ? 'disabled' : ''} aria-label="上一轮">‹</button>
          <span class="turn-pager-label">第 ${turn.turnIndex}/${totalTurns} 轮</span>
          <button type="button" class="turn-nav-btn" data-turn-nav="1" ${idx === totalTurns - 1 ? 'disabled' : ''} aria-label="下一轮">›</button>
        </span>`
        : '';

    cardEl.innerHTML = `
      <div class="live-card-head">
        <div class="live-card-title-wrap">
          <span class="live-card-model">${esc(turn.modelLabel)}</span>
          ${live.isFallbackLatest ? '<span class="badge badge-fallback" title="独立打开模式，展示最近活跃会话">最近会话</span>' : ''}
        </div>
        <div class="live-card-right">
          ${pagerHtml}
          <span class="step-pill">${fmtInt(turn.steps)} 步</span>
        </div>
      </div>
      <div class="live-card-rows">
        <div class="live-row">
          <span class="live-row-label">当前上下文</span>
          <span class="live-row-val">${fmtInt(turn.contextTokens)} / ${esc(fmtWindow(turn.contextWindow))} (${ctxPctNum}%)</span>
        </div>
        <div class="ctx-bar-track" aria-hidden="true">
          <div class="ctx-bar-fill${ctxClass}" style="width:${ctxBarW}%"></div>
        </div>
        <div class="live-row" title="本轮官方定价费用约 ${esc(turnCostStr)}">
          <span class="live-row-label">本轮输出</span>
          <span class="live-row-val">${fmtInt(turn.output)}</span>
        </div>
        <div class="live-row">
          <span class="live-row-label">本轮累计输入</span>
          <span class="live-row-val">新增 ${fmtInt(turn.input)} + 读缓存 ${fmtInt(turn.cacheRead)} <span class="live-row-muted">(命中率 ${esc(fmtPct(turn.cacheHitRate))})</span></span>
        </div>
        <div class="live-row" title="${esc(durTip)}">
          <span class="live-row-label">速度与耗时</span>
          <span class="live-row-val">${esc(tpsVal)} <span class="live-row-muted">(${esc(tpsScope)}) · ${durPrefix}</span> ${esc(fmtDuration(durSec))}${durBreakdown}</span>
        </div>
      </div>
    `;

    cardEl.querySelectorAll('.turn-nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const delta = Number(btn.dataset.turnNav);
        const nextTurn = Math.min(totalTurns, Math.max(1, turn.turnIndex + delta));
        state.selectedTurnIdx = nextTurn === totalTurns ? null : nextTurn;
        renderLiveConversation(report);
      });
    });
  }

  // ---------- Rendering ----------
  function renderHeader(report) {
    const { code, sym } = currencyMeta(report.prefs);
    $('btn-currency').textContent = `${code} ${sym}`;
    $('header-meta').textContent = `${report.allTime.totalSessions} 会话 · ${report.period.activeDays} 活跃天`;
    $('tab-count-models').textContent = report.models.length ? String(report.models.length) : '';
    $('tab-count-sessions').textContent = report.sessions.length ? String(report.sessions.length) : '';
  }

  function renderKpis(report) {
    const p = report.prefs;
    const periodLabel =
      report.rangeDays === 0 ? '全部周期费用' : report.rangeDays === 1 ? '今日费用' : `近 ${report.rangeDays} 天费用`;
    const todaySub = `今日 ${fmtMoney(report.today.costUsd, p)} · 日均 ${fmtMoney(report.period.avgDailyCostUsd, p)}`;

    const sess = report.activeSession;
    const card4 = sess
      ? {
          label: '当前会话',
          value: fmtMoney(sess.costUsd, p),
          sub: `${fmtCompact(sess.total)} tok · ${sess.steps} 步`,
        }
      : {
          label: '累计总费用',
          value: fmtMoney(report.allTime.costUsd, p),
          sub: `${fmtCompact(report.allTime.total)} tok · ${report.allTime.totalSessions} 会话`,
        };

    const cards = [
      {
        label: periodLabel,
        value: fmtMoney(report.period.costUsd, p),
        sub: todaySub,
      },
      {
        label: '周期总 Token',
        value: fmtCompact(report.period.total),
        sub: `入 ${fmtCompact(report.period.input)} · 缓 ${fmtCompact(report.period.cacheRead)} · 出 ${fmtCompact(report.period.output)}`,
      },
      {
        label: '缓存命中率',
        value: fmtPct(report.period.cacheHitRate),
        sub: `缓存节省约 ${fmtMoney(report.period.cacheSavedUsd, p)}`,
      },
      card4,
    ];

    $('kpi-grid').innerHTML = cards
      .map(
        (c) => `
      <div class="kpi-card">
        <div class="kpi-label"><span>${esc(c.label)}</span></div>
        <div class="kpi-value">${esc(c.value)}</div>
        <div class="kpi-sub" title="${esc(c.sub)}">${esc(c.sub)}</div>
      </div>`,
      )
      .join('');
  }

  function renderChart(report) {
    const daily = report.daily || [];
    const wrap = $('chart-wrap');
    const legend = $('chart-legend');
    const detail = $('chart-detail');

    if (daily.length === 0) {
      legend.innerHTML = '';
      wrap.innerHTML = '<div class="empty-state">当前时间范围内暂无 Token 记录</div>';
      detail.innerHTML = '';
      return;
    }

    if (!state.selectedDate || !daily.some((d) => d.date === state.selectedDate)) {
      const lastActive = [...daily].reverse().find((d) => d.steps > 0);
      state.selectedDate = (lastActive || daily[daily.length - 1]).date;
    }

    const p = report.prefs;
    const isCost = state.metric === 'cost';

    if (isCost) {
      legend.innerHTML =
        '<span class="legend-item"><span class="legend-swatch" style="background:var(--tm-cost)"></span>每日费用（Google 官方 API 定价）</span>';
    } else {
      legend.innerHTML = `
        <span class="legend-item"><span class="legend-swatch" style="background:var(--tm-cache)"></span>缓存读 (Cache Read)</span>
        <span class="legend-item"><span class="legend-swatch" style="background:var(--tm-input)"></span>常规输入 (Input)</span>
        <span class="legend-item"><span class="legend-swatch" style="background:var(--tm-output)"></span>输出 (Output)</span>
      `;
    }

    const W = 640;
    const H = 196;
    const padL = 52;
    const padR = 12;
    const padT = 14;
    const padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const maxVal = Math.max(
      ...daily.map((d) => (isCost ? d.costUsd : d.total)),
      isCost ? 0.01 : 1000,
    );

    const yTicks = [0, 0.25, 0.5, 0.75, 1];
    const gridSvg = yTicks
      .map((t) => {
        const y = padT + plotH * (1 - t);
        const val = maxVal * t;
        const lbl = isCost ? fmtMoney(val, p, true) : fmtCompact(val);
        return `
          <line class="chart-grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" />
          <text class="chart-axis-text" x="${padL - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${esc(lbl)}</text>
        `;
      })
      .join('');

    const n = daily.length;
    const stepW = plotW / n;
    const barW = Math.max(3, Math.min(34, stepW * 0.66));
    const maxLabels = Math.min(n, 7);
    const labelEvery = Math.max(1, Math.ceil(n / maxLabels));

    const barsSvg = daily
      .map((d, idx) => {
        const cx = padL + idx * stepW + stepW / 2;
        const bx = cx - barW / 2;
        const selected = d.date === state.selectedDate;
        let shapes = '';

        if (isCost) {
          const h = Math.max(d.costUsd > 0 ? 2 : 0, (d.costUsd / maxVal) * plotH);
          const y = padT + plotH - h;
          shapes = `<rect x="${bx.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2.5" fill="var(--tm-cost)" opacity="${selected ? '1' : '0.84'}" />`;
        } else {
          const hCache = (d.cacheRead / maxVal) * plotH;
          const hIn = (d.input / maxVal) * plotH;
          const hOut = (d.output / maxVal) * plotH;
          const yCache = padT + plotH - hCache;
          const yIn = yCache - hIn;
          const yOut = yIn - hOut;
          const op = selected ? '1' : '0.86';
          shapes = `
            ${hCache > 0 ? `<rect x="${bx.toFixed(1)}" y="${yCache.toFixed(1)}" width="${barW.toFixed(1)}" height="${hCache.toFixed(1)}" fill="var(--tm-cache)" opacity="${op}" />` : ''}
            ${hIn > 0 ? `<rect x="${bx.toFixed(1)}" y="${yIn.toFixed(1)}" width="${barW.toFixed(1)}" height="${hIn.toFixed(1)}" fill="var(--tm-input)" opacity="${op}" />` : ''}
            ${hOut > 0 ? `<rect x="${bx.toFixed(1)}" y="${yOut.toFixed(1)}" width="${barW.toFixed(1)}" height="${hOut.toFixed(1)}" rx="1.5" fill="var(--tm-output)" opacity="${op}" />` : ''}
          `;
        }

        const showTick = idx === 0 || idx === n - 1 || idx % labelEvery === 0;
        const shortDate = d.date.slice(5);
        const tick = showTick
          ? `<text class="chart-axis-text" x="${cx.toFixed(1)}" y="${H - 7}" text-anchor="middle">${esc(shortDate)}</text>`
          : '';

        return `
          <g class="bar-group${selected ? ' selected' : ''}" data-date="${esc(d.date)}">
            <rect class="bar-hit" x="${(padL + idx * stepW).toFixed(1)}" y="${padT}" width="${stepW.toFixed(1)}" height="${plotH}" />
            ${shapes}
            ${tick}
          </g>
        `;
      })
      .join('');

    wrap.innerHTML = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="每日趋势图">${gridSvg}${barsSvg}</svg>`;

    const selectDay = (dateStr) => {
      state.selectedDate = dateStr;
      wrap.querySelectorAll('.bar-group').forEach((g) => {
        g.classList.toggle('selected', g.dataset.date === dateStr);
      });
      $('daily-tbody')
        .querySelectorAll('tr')
        .forEach((tr) => tr.classList.toggle('selected-row', tr.dataset.date === dateStr));
      renderSelectedDetail(report);
    };

    wrap.querySelectorAll('.bar-group').forEach((g) => {
      g.addEventListener('mouseenter', () => selectDay(g.dataset.date));
      g.addEventListener('click', () => selectDay(g.dataset.date));
    });

    renderSelectedDetail(report);
  }

  function renderSelectedDetail(report) {
    const d = (report.daily || []).find((x) => x.date === state.selectedDate);
    if (!d) {
      $('chart-detail').innerHTML = '';
      return;
    }
    const p = report.prefs;
    $('chart-detail').innerHTML = `
      <span class="detail-date">${esc(d.date)}${d.date === report.todayDate ? ' (今日)' : ''}</span>
      <div class="detail-metrics">
        <span>费用 <strong>${esc(fmtMoney(d.costUsd, p))}</strong></span>
        <span>步数 <strong>${fmtInt(d.steps)}</strong></span>
        <span>输入 <strong>${fmtCompact(d.input)}</strong></span>
        <span>缓存读 <strong>${fmtCompact(d.cacheRead)}</strong> (${fmtPct(d.cacheHitRate)})</span>
        <span>输出 <strong>${fmtCompact(d.output)}</strong></span>
      </div>
    `;
  }

  function renderDailyTable(report) {
    const p = report.prefs;
    const rows = [...(report.daily || [])].reverse();
    const tbody = $('daily-tbody');
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">暂无数据</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map(
        (d) => `
      <tr data-date="${esc(d.date)}" class="${d.date === state.selectedDate ? 'selected-row' : ''}">
        <td><code>${esc(d.date)}</code>${d.date === report.todayDate ? ' <span class="badge badge-current">今</span>' : ''}</td>
        <td class="num">${fmtInt(d.steps)}</td>
        <td class="num">${fmtCompact(d.input)}</td>
        <td class="num">${fmtCompact(d.cacheRead)}</td>
        <td class="num">${fmtCompact(d.output)}</td>
        <td class="num">${d.steps > 0 ? fmtPct(d.cacheHitRate) : '—'}</td>
        <td class="num cost-cell">${fmtMoney(d.costUsd, p)}</td>
      </tr>`,
      )
      .join('');

    tbody.querySelectorAll('tr').forEach((tr) => {
      tr.addEventListener('click', () => {
        state.selectedDate = tr.dataset.date;
        renderChart(report);
        tbody.querySelectorAll('tr').forEach((r) => r.classList.toggle('selected-row', r === tr));
      });
    });
  }

  function renderModels(report) {
    const p = report.prefs;
    const models = report.models || [];
    $('models-subtitle').textContent = `共 ${models.length} 个模型 · 周期总计 ${fmtMoney(report.period.costUsd, p)}`;
    const box = $('models-list');

    if (models.length === 0) {
      box.innerHTML = '<div class="empty-state">当前周期内无模型使用记录</div>';
      return;
    }

    const maxCost = Math.max(...models.map((m) => m.costUsd), 0.0001);
    box.innerHTML = models
      .map((m) => {
        const w = Math.max(2, Math.round((m.costUsd / maxCost) * 100));
        const badge =
          m.matchType === 'official'
            ? `<span class="badge badge-official" title="${esc(m.tierNote || 'Google 官方定价')}">官方定价</span>`
            : `<span class="badge badge-fallback" title="${esc(m.tierNote || '旧版日志未记录模型名')}">历史估算</span>`;
        return `
        <div class="model-row">
          <div class="model-top">
            <div class="model-ident">
              <span class="model-name">${esc(m.label)}</span>
              ${m.model !== 'unknown' ? `<span class="model-slug">${esc(m.model)}</span>` : ''}
              ${badge}
            </div>
            <div class="model-cost-wrap">
              <span class="model-cost">${esc(fmtMoney(m.costUsd, p))}</span>
              <span class="model-share">${m.sharePct.toFixed(1)}%</span>
            </div>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div>
          <div class="model-meta">
            <span>${fmtInt(m.steps)} 步 · 入 ${fmtCompact(m.input)} · 缓 ${fmtCompact(m.cacheRead)} (${fmtPct(m.cacheHitRate)}) · 出 ${fmtCompact(m.output)}</span>
            <span title="${esc(m.tierNote || '')}">$${m.rate.input} / $${m.rate.cacheRead} / $${m.rate.output} per 1M</span>
          </div>
        </div>`;
      })
      .join('');
  }

  function renderSessions(report) {
    const p = report.prefs;
    const q = state.sessionSearch.trim().toLowerCase();
    let list = [...(report.sessions || [])];
    if (q) {
      list = list.filter(
        (s) =>
          (s.title || '').toLowerCase().includes(q) ||
          s.convId.toLowerCase().includes(q) ||
          s.primaryModel.toLowerCase().includes(q),
      );
    }
    if (state.sessionSort === 'tokens') {
      list.sort((a, b) => b.total - a.total);
    } else if (state.sessionSort === 'recent') {
      list.sort((a, b) => b.lastTs - a.lastTs);
    } else {
      list.sort((a, b) => b.costUsd - a.costUsd || b.lastTs - a.lastTs);
    }

    const canOpen = Boolean(window.sidecar?.ui?.toggleConversation);
    const box = $('sessions-list');
    if (list.length === 0) {
      box.innerHTML = '<div class="empty-state">没有匹配的会话记录</div>';
      return;
    }

    const totalMatched = list.length;
    const visible = list.slice(0, 100);
    const overflowNote =
      totalMatched > visible.length
        ? `<div class="card-sub" style="text-align:center;padding:6px 0;">仅展示前 ${visible.length} / 共 ${totalMatched} 个匹配会话，可通过关键词缩小范围</div>`
        : '';

    box.innerHTML =
      visible
        .map(
          (s) => `
      <button type="button" class="session-row${canOpen ? ' clickable' : ''}${s.isCurrent ? ' is-current' : ''}" data-conv="${esc(s.convId)}" title="${canOpen ? '点击跳转到此会话' : esc(s.convId)}">
        <div class="session-head">
          <div class="session-title">${esc(s.title || `会话 ${s.convId.slice(0, 8)}`)}</div>
          <div class="session-cost">${esc(fmtMoney(s.costUsd, p))}</div>
        </div>
        <div class="session-foot">
          ${s.isCurrent ? '<span class="badge badge-current">当前会话</span>' : ''}
          <span>${esc(s.primaryModelLabel)}</span>
          <span>${fmtInt(s.steps)} 步</span>
          <span>${fmtCompact(s.total)} tok (命中 ${fmtPct(s.cacheHitRate)})</span>
          <span class="spacer"></span>
          <span>${esc(fmtRelTime(s.lastTs))}</span>
        </div>
      </button>`,
        )
        .join('') + overflowNote;

    box.querySelectorAll('.session-row').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.conv;
        if (window.sidecar?.ui?.toggleConversation) {
          window.sidecar.ui.toggleConversation(id);
        } else if (navigator.clipboard) {
          navigator.clipboard.writeText(id).then(() => showToast(`已复制会话 ID: ${id.slice(0, 8)}`));
        }
      });
    });
  }

  function renderAll(report) {
    state.report = report;
    $('loading').classList.add('hidden');
    $('app').classList.remove('hidden');

    renderHeader(report);
    renderLiveConversation(report);
    renderKpis(report);
    renderChart(report);
    renderDailyTable(report);
    renderModels(report);
    renderSessions(report);
  }

  // ---------- Polling & Actions ----------
  async function loadReport({ force = false } = {}) {
    const qs = new URLSearchParams({
      days: String(state.days),
    });
    const tz = clientTimeZone();
    if (tz) qs.set('tz', tz);
    const conv = activeConvId();
    if (conv) qs.set('conversationId', conv);
    if (!force && state.etag) qs.set('etag', state.etag);
    if (force) qs.set('force', '1');

    try {
      const data = await getJson(`/api/report?${qs.toString()}`);
      const pill = $('live-pill');
      pill.classList.remove('syncing');
      if (data.syncError) {
        pill.classList.add('syncing');
        pill.title = `同步异常: ${data.syncError}${data.syncedAt ? ` (上次成功: ${fmtRelTime(data.syncedAt)})` : ''}`;
        $('live-text').textContent = '同步异常';
      } else {
        pill.title = data.syncedAt ? `每 3 秒自动增量同步 · 上次同步: ${fmtRelTime(data.syncedAt)}` : '每 3 秒自动增量同步';
        $('live-text').textContent = 'Live';
      }
      if (data.unchanged) return;
      state.etag = data.etag || '';
      renderAll(data);
    } catch (err) {
      $('live-text').textContent = '离线';
      console.error('[token-meter] poll failed:', err);
    }
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(async () => {
      await loadReport({ force: false });
      schedulePoll();
    }, POLL_MS);
  }

  function switchTab(tabName) {
    state.tab = tabName;
    document.querySelectorAll('.tab').forEach((t) => {
      const active = t.dataset.tab === tabName;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `panel-${tabName}`);
    });
  }

  // ---------- Event Wiring ----------
  $('live-turn-toggle').addEventListener('click', () => {
    state.liveCardOpen = !state.liveCardOpen;
    try {
      localStorage.setItem('tm_live_card_open', state.liveCardOpen ? '1' : '0');
    } catch {
      // ignore
    }
    $('live-turn-toggle').setAttribute('aria-expanded', String(state.liveCardOpen));
    $('live-turn-card').classList.toggle('hidden', !state.liveCardOpen);
  });

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('range-group').querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.days = Number(btn.dataset.days);
      state.etag = '';
      state.selectedDate = null;
      $('range-group')
        .querySelectorAll('.seg-btn')
        .forEach((b) => b.classList.toggle('active', b === btn));
      loadReport({ force: false });
    });
  });

  document.querySelectorAll('[data-metric]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.metric = btn.dataset.metric;
      document
        .querySelectorAll('[data-metric]')
        .forEach((b) => b.classList.toggle('active', b === btn));
      if (state.report) renderChart(state.report);
    });
  });

  $('btn-currency').addEventListener('click', async () => {
    if (!state.report) return;
    const next = state.report.prefs.currency === 'CNY' ? 'USD' : 'CNY';
    try {
      await postJson('/api/prefs', { currency: next });
      state.etag = '';
      await loadReport({ force: false });
      showToast(`已切换为 ${next}`);
    } catch (err) {
      showToast(`切换失败: ${err.message}`);
    }
  });

  $('btn-sync').addEventListener('click', async () => {
    const btn = $('btn-sync');
    btn.classList.add('spinning');
    $('live-pill').classList.add('syncing');
    try {
      const res = await postJson('/api/sync', { full: false });
      state.etag = '';
      await loadReport({ force: true });
      showToast(res.added > 0 ? `已同步新增 ${res.added} 条记录` : '已是最新');
    } catch (err) {
      showToast(`同步失败: ${err.message}`);
    } finally {
      btn.classList.remove('spinning');
      $('live-pill').classList.remove('syncing');
    }
  });

  $('btn-export').addEventListener('click', async () => {
    try {
      const qs = new URLSearchParams({
        days: String(state.days),
      });
      const tz = clientTimeZone();
      if (tz) qs.set('tz', tz);
      const res = await apiFetch(`/api/export.csv?${qs.toString()}`, { method: 'GET' });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `token-meter-${state.report?.todayDate || 'export'}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('CSV 已导出');
    } catch (err) {
      showToast(`导出失败: ${err.message}`);
    }
  });

  $('session-search').addEventListener('input', (e) => {
    state.sessionSearch = e.target.value;
    if (state.report) renderSessions(state.report);
  });

  $('session-sort').addEventListener('change', (e) => {
    state.sessionSort = e.target.value;
    if (state.report) renderSessions(state.report);
  });

  // Boot
  loadReport({ force: true }).then(schedulePoll);
})();
