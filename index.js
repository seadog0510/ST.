// SillyTavern Prompt Inspector
// 提示词诊断面板：每次发送的完整结构可视化
// 数据策略：CHAT_COMPLETION_PROMPT_READY 拿 messages，WORLD_INFO_ACTIVATED 拿 WI 命中，fetch 拦截兜底校验

import { eventSource, event_types } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

const MODULE = 'prompt_inspector';

// ============ 全局状态 ============
const state = {
    lastSnapshot: null,           // 最近一次快照
    activatedWI: [],              // 最近一次 WI 命中
    interceptedPayload: null,     // fetch 拦截到的实际 payload
    history: [],                  // 历史快照（最多 10 条）
    panelOpen: false,
    autoOpen: false,
};

const MAX_HISTORY = 10;

// ============ Token 估算（轻量级，不依赖 ST 内部 tokenizer） ============
// 粗略估算：英文 ~4 字符/token，中文 ~1.5 字符/token，混合按 2.5 算
function estimateTokens(text) {
    if (!text) return 0;
    if (typeof text !== 'string') text = JSON.stringify(text);
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const otherChars = text.length - chineseChars;
    return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

// 优先用 ST 自带的 tokenizer（如果可用）
function countTokens(text) {
    try {
        const ctx = getContext();
        if (ctx && typeof ctx.getTokenCountAsync === 'function') {
            // 异步的，这里同步路径用估算
        }
    } catch (e) { /* 忽略 */ }
    return estimateTokens(text);
}

// ============ 消息来源识别 ============
// 根据消息内容/role 推断来源类别
function classifySource(msg, index, total) {
    const content = (msg.content || '').toString();
    const role = msg.role;

    // ST 在 CHAT_COMPLETION_PROMPT_READY 的 chat 数组里通常带有 identifier 或 name 字段
    if (msg.identifier) {
        const id = msg.identifier.toLowerCase();
        if (id.includes('main') || id.includes('system')) return 'preset_main';
        if (id.includes('jailbreak') || id.includes('nsfw')) return 'preset_jb';
        if (id.includes('persona')) return 'persona';
        if (id.includes('charDescription') || id.includes('char_desc')) return 'char_card';
        if (id.includes('charPersonality')) return 'char_card';
        if (id.includes('scenario')) return 'char_card';
        if (id.includes('worldInfo') || id.includes('world_info')) return 'world_info';
        if (id.includes('dialogueExamples')) return 'char_examples';
        if (id.includes('chatHistory')) return 'history';
        if (id.includes('newChat') || id.includes('newGroup')) return 'preset_other';
        return 'preset_other';
    }

    // 标记字段
    if (msg.name === 'depth_prompt' || (msg.extra && msg.extra.depth_prompt)) {
        return 'depth_prompt';
    }

    // 历史消息特征：靠后 + assistant/user 交替
    const isLatter = index >= total - 30;
    if (isLatter && (role === 'user' || role === 'assistant')) {
        return 'history';
    }

    if (role === 'system') return 'preset_other';
    return role === 'user' ? 'history' : 'history';
}

const SOURCE_META = {
    preset_main:    { label: '预设·主提示',  color: '#6366f1' },
    preset_jb:      { label: '预设·越狱',    color: '#ec4899' },
    preset_other:   { label: '预设·其他',    color: '#8b5cf6' },
    char_card:      { label: '角色卡',       color: '#f59e0b' },
    char_examples:  { label: '对话示例',     color: '#fbbf24' },
    persona:        { label: '玩家人设',     color: '#10b981' },
    world_info:     { label: '世界书',       color: '#3b82f6' },
    depth_prompt:   { label: 'Depth Prompt', color: '#ef4444' },
    history:        { label: '聊天历史',     color: '#64748b' },
    unknown:        { label: '未分类',       color: '#9ca3af' },
};

// ============ 构建快照 ============
function buildSnapshot(chatArray) {
    const messages = (chatArray || []).map((msg, i, arr) => {
        const source = classifySource(msg, i, arr.length) || 'unknown';
        const content = (msg.content || '').toString();
        const tokens = countTokens(content);
        return {
            index: i,
            role: msg.role,
            name: msg.name || msg.identifier || '',
            content,
            tokens,
            source,
            preview: content.slice(0, 200),
        };
    });

    // Token 按来源汇总
    const tokensBySource = {};
    let totalTokens = 0;
    for (const m of messages) {
        tokensBySource[m.source] = (tokensBySource[m.source] || 0) + m.tokens;
        totalTokens += m.tokens;
    }

    return {
        timestamp: Date.now(),
        messages,
        tokensBySource,
        totalTokens,
        messageCount: messages.length,
        activatedWI: [...state.activatedWI],
    };
}

// ============ 事件钩子 ============
function attachEvents() {
    // 主入口：CC 模式下，prompt 组装完成、即将发送
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (data) => {
        try {
            // data.chat 是发送给 API 的 messages 数组
            const chatArray = data?.chat || data?.messages || [];
            const snap = buildSnapshot(chatArray);
            snap.dryRun = !!data?.dryRun;

            state.lastSnapshot = snap;
            state.history.unshift(snap);
            if (state.history.length > MAX_HISTORY) state.history.pop();

            renderPanel();
            if (state.autoOpen) openPanel();
        } catch (e) {
            console.error('[PromptInspector] CHAT_COMPLETION_PROMPT_READY 处理失败:', e);
        }
    });

    // 文本补全模式：generate_after_data
    if (event_types.GENERATE_AFTER_DATA) {
        eventSource.on(event_types.GENERATE_AFTER_DATA, (data) => {
            try {
                // 文本补全模式下没有 messages 数组，用 prompt 字符串包一层
                if (!data) return;
                const fakeChat = [{
                    role: 'system',
                    content: data.prompt || JSON.stringify(data),
                    identifier: 'tc_combined',
                }];
                const snap = buildSnapshot(fakeChat);
                snap.textCompletion = true;
                state.lastSnapshot = snap;
                state.history.unshift(snap);
                if (state.history.length > MAX_HISTORY) state.history.pop();
                renderPanel();
            } catch (e) {
                console.error('[PromptInspector] GENERATE_AFTER_DATA 处理失败:', e);
            }
        });
    }

    // 世界书命中
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, (entries) => {
        try {
            state.activatedWI = (entries || []).map(e => ({
                world: e.world || e.book || '',
                comment: e.comment || '',
                key: Array.isArray(e.key) ? e.key.join(', ') : (e.key || ''),
                content: (e.content || '').slice(0, 500),
                depth: e.depth ?? null,
                order: e.order ?? null,
                position: e.position ?? null,
                constant: !!e.constant,
                selective: !!e.selective,
                tokens: countTokens(e.content || ''),
            }));
        } catch (e) {
            console.error('[PromptInspector] WORLD_INFO_ACTIVATED 处理失败:', e);
        }
    });

    // 生成结束，刷新一次（确保 WI 数据合并到当前快照）
    eventSource.on(event_types.GENERATION_STARTED, () => {
        if (state.lastSnapshot) {
            state.lastSnapshot.activatedWI = [...state.activatedWI];
            renderPanel();
        }
    });
}

// ============ Fetch 拦截兜底 ============
// 抓真实发往 /api/backends/chat-completions/generate 的 payload，对照事件数据
function attachFetchHook() {
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
        try {
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
            const opts = args[1];
            if (url && typeof url === 'string' &&
                (url.includes('/chat-completions/generate') ||
                 url.includes('/openai/generate') ||
                 url.includes('/generate'))) {
                if (opts && opts.body) {
                    try {
                        const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
                        state.interceptedPayload = {
                            url,
                            timestamp: Date.now(),
                            messages: body.messages || null,
                            prompt: body.prompt || null,
                            model: body.model || null,
                            max_tokens: body.max_tokens || body.max_length,
                            temperature: body.temperature,
                            raw: body,
                        };
                        // 如果事件没拿到（极少数情况），用 fetch 数据补
                        if (!state.lastSnapshot && body.messages) {
                            const snap = buildSnapshot(body.messages);
                            snap.fromFetch = true;
                            state.lastSnapshot = snap;
                            state.history.unshift(snap);
                            renderPanel();
                        } else if (state.lastSnapshot) {
                            state.lastSnapshot.fetchPayload = state.interceptedPayload;
                            renderPanel();
                        }
                    } catch (e) { /* 非 JSON body 忽略 */ }
                }
            }
        } catch (e) { /* 不影响请求 */ }
        return origFetch.apply(this, args);
    };
}

// ============ UI ============
function injectPanel() {
    if (document.getElementById('prompt-inspector-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'prompt-inspector-panel';
    panel.className = 'pi-panel pi-collapsed';
    panel.innerHTML = `
        <div class="pi-header">
            <span class="pi-title">🔍 Prompt Inspector</span>
            <div class="pi-controls">
                <label class="pi-toggle" title="发送后自动展开">
                    <input type="checkbox" id="pi-auto-open"> 自动
                </label>
                <select id="pi-history" class="pi-select" title="历史快照"></select>
                <button id="pi-collapse" class="pi-btn-icon" title="折叠/展开">▸</button>
            </div>
        </div>
        <div class="pi-body">
            <div class="pi-tabs">
                <button class="pi-tab pi-tab-active" data-tab="overview">概览</button>
                <button class="pi-tab" data-tab="messages">消息流</button>
                <button class="pi-tab" data-tab="worldinfo">世界书</button>
                <button class="pi-tab" data-tab="depth">Depth</button>
                <button class="pi-tab" data-tab="raw">原始</button>
            </div>
            <div class="pi-content">
                <div class="pi-tab-pane pi-pane-active" data-pane="overview"></div>
                <div class="pi-tab-pane" data-pane="messages"></div>
                <div class="pi-tab-pane" data-pane="worldinfo"></div>
                <div class="pi-tab-pane" data-pane="depth"></div>
                <div class="pi-tab-pane" data-pane="raw"></div>
            </div>
        </div>
    `;
    document.body.appendChild(panel);

    // 折叠/展开
    panel.querySelector('#pi-collapse').addEventListener('click', () => {
        panel.classList.toggle('pi-collapsed');
        state.panelOpen = !panel.classList.contains('pi-collapsed');
    });
    panel.querySelector('.pi-header').addEventListener('dblclick', () => {
        panel.classList.toggle('pi-collapsed');
        state.panelOpen = !panel.classList.contains('pi-collapsed');
    });

    // 自动开关
    panel.querySelector('#pi-auto-open').addEventListener('change', (e) => {
        state.autoOpen = e.target.checked;
    });

    // tab 切换
    panel.querySelectorAll('.pi-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            panel.querySelectorAll('.pi-tab').forEach(t => t.classList.remove('pi-tab-active'));
            panel.querySelectorAll('.pi-tab-pane').forEach(p => p.classList.remove('pi-pane-active'));
            tab.classList.add('pi-tab-active');
            const target = tab.dataset.tab;
            panel.querySelector(`.pi-tab-pane[data-pane="${target}"]`).classList.add('pi-pane-active');
        });
    });

    // 历史选择
    panel.querySelector('#pi-history').addEventListener('change', (e) => {
        const idx = parseInt(e.target.value, 10);
        if (!isNaN(idx) && state.history[idx]) {
            state.lastSnapshot = state.history[idx];
            renderPanel();
        }
    });

    // 拖动支持（简易）
    makeDraggable(panel);

    // 拖到右侧使其常驻
    panel.style.right = '10px';
    panel.style.top = '60px';
}

function openPanel() {
    const panel = document.getElementById('prompt-inspector-panel');
    if (panel) {
        panel.classList.remove('pi-collapsed');
        state.panelOpen = true;
    }
}

function makeDraggable(el) {
    const header = el.querySelector('.pi-header');
    let offX = 0, offY = 0, dragging = false;

    const isInteractive = (target) => {
        return target.tagName === 'BUTTON' || target.tagName === 'INPUT' ||
               target.tagName === 'SELECT' || target.tagName === 'LABEL' ||
               target.tagName === 'TEXTAREA' || target.closest('button');
    };

    header.addEventListener('mousedown', (e) => {
        if (isInteractive(e.target)) return;
        dragging = true;
        offX = e.clientX - el.offsetLeft;
        offY = e.clientY - el.offsetTop;
        e.preventDefault();
    });
    header.addEventListener('touchstart', (e) => {
        if (isInteractive(e.target)) return;
        const t = e.touches[0];
        dragging = true;
        offX = t.clientX - el.offsetLeft;
        offY = t.clientY - el.offsetTop;
        e.preventDefault();
    }, { passive: false });

    const onMove = (clientX, clientY) => {
        if (!dragging) return;
        const maxX = window.innerWidth - 40;
        const maxY = window.innerHeight - 40;
        const newX = Math.max(0, Math.min(maxX, clientX - offX));
        const newY = Math.max(0, Math.min(maxY, clientY - offY));
        el.style.left = newX + 'px';
        el.style.top = newY + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    };

    document.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
    document.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        const t = e.touches[0];
        onMove(t.clientX, t.clientY);
        e.preventDefault();
    }, { passive: false });
    document.addEventListener('mouseup', () => { dragging = false; });
    document.addEventListener('touchend', () => { dragging = false; });
    document.addEventListener('touchcancel', () => { dragging = false; });
}

function renderPanel() {
    const panel = document.getElementById('prompt-inspector-panel');
    if (!panel) return;
    const snap = state.lastSnapshot;

    // 历史下拉
    const sel = panel.querySelector('#pi-history');
    sel.innerHTML = state.history.map((s, i) => {
        const t = new Date(s.timestamp);
        const time = t.toLocaleTimeString('zh-CN', { hour12: false });
        return `<option value="${i}">${i === 0 ? '● ' : ''}${time} · ${s.totalTokens}t</option>`;
    }).join('');

    if (!snap) {
        panel.querySelector('[data-pane="overview"]').innerHTML = '<div class="pi-empty">还没有数据，发送一条消息试试 ✨</div>';
        return;
    }

    renderOverview(panel.querySelector('[data-pane="overview"]'), snap);
    renderMessages(panel.querySelector('[data-pane="messages"]'), snap);
    renderWorldInfo(panel.querySelector('[data-pane="worldinfo"]'), snap);
    renderDepth(panel.querySelector('[data-pane="depth"]'), snap);
    renderRaw(panel.querySelector('[data-pane="raw"]'), snap);
}

function renderOverview(el, snap) {
    const total = snap.totalTokens || 1;
    const sources = Object.entries(snap.tokensBySource).sort((a, b) => b[1] - a[1]);

    // SVG 饼图
    let cumAngle = 0;
    const radius = 70, cx = 80, cy = 80;
    const slices = sources.map(([key, val]) => {
        const angle = (val / total) * 2 * Math.PI;
        const x1 = cx + radius * Math.cos(cumAngle);
        const y1 = cy + radius * Math.sin(cumAngle);
        cumAngle += angle;
        const x2 = cx + radius * Math.cos(cumAngle);
        const y2 = cy + radius * Math.sin(cumAngle);
        const large = angle > Math.PI ? 1 : 0;
        const meta = SOURCE_META[key] || SOURCE_META.unknown;
        return `<path d="M${cx},${cy} L${x1},${y1} A${radius},${radius} 0 ${large} 1 ${x2},${y2} Z" fill="${meta.color}" stroke="#1a1a1a" stroke-width="1"/>`;
    }).join('');

    const legend = sources.map(([key, val]) => {
        const meta = SOURCE_META[key] || SOURCE_META.unknown;
        const pct = ((val / total) * 100).toFixed(1);
        return `<div class="pi-legend-row">
            <span class="pi-legend-dot" style="background:${meta.color}"></span>
            <span class="pi-legend-label">${meta.label}</span>
            <span class="pi-legend-tokens">${val}t</span>
            <span class="pi-legend-pct">${pct}%</span>
        </div>`;
    }).join('');

    const meta = `
        <div class="pi-meta">
            <div><b>消息数</b>: ${snap.messageCount}</div>
            <div><b>总 token</b>: ~${snap.totalTokens} <span class="pi-hint">(估算)</span></div>
            <div><b>WI 命中</b>: ${snap.activatedWI.length}</div>
            ${snap.dryRun ? '<div class="pi-tag">DRY RUN</div>' : ''}
            ${snap.fromFetch ? '<div class="pi-tag pi-tag-warn">FETCH 兜底</div>' : ''}
            ${snap.textCompletion ? '<div class="pi-tag">文本补全</div>' : ''}
        </div>
    `;

    el.innerHTML = `
        ${meta}
        <div class="pi-pie-wrap">
            <svg viewBox="0 0 160 160" class="pi-pie">${slices}</svg>
            <div class="pi-legend">${legend}</div>
        </div>
    `;
}

function renderMessages(el, snap) {
    const rows = snap.messages.map(m => {
        const meta = SOURCE_META[m.source] || SOURCE_META.unknown;
        return `
            <div class="pi-msg" data-idx="${m.index}">
                <div class="pi-msg-head">
                    <span class="pi-msg-idx">#${m.index}</span>
                    <span class="pi-msg-role pi-role-${m.role}">${m.role}</span>
                    <span class="pi-msg-source" style="background:${meta.color}22;color:${meta.color};border-color:${meta.color}">${meta.label}</span>
                    ${m.name ? `<span class="pi-msg-name">${escapeHtml(m.name)}</span>` : ''}
                    <span class="pi-msg-tokens">~${m.tokens}t</span>
                </div>
                <div class="pi-msg-preview">${escapeHtml(m.preview)}${m.content.length > 200 ? '…' : ''}</div>
            </div>
        `;
    }).join('');
    el.innerHTML = `<div class="pi-msg-list">${rows}</div>`;

    // 点击展开全文
    el.querySelectorAll('.pi-msg').forEach(node => {
        node.addEventListener('click', () => {
            const idx = parseInt(node.dataset.idx, 10);
            const m = snap.messages[idx];
            if (!m) return;
            const preview = node.querySelector('.pi-msg-preview');
            if (preview.classList.contains('pi-msg-full')) {
                preview.classList.remove('pi-msg-full');
                preview.textContent = m.preview + (m.content.length > 200 ? '…' : '');
            } else {
                preview.classList.add('pi-msg-full');
                preview.textContent = m.content;
            }
        });
    });
}

function renderWorldInfo(el, snap) {
    if (!snap.activatedWI || snap.activatedWI.length === 0) {
        el.innerHTML = '<div class="pi-empty">本次没有世界书条目命中</div>';
        return;
    }
    const rows = snap.activatedWI.map((wi, i) => `
        <div class="pi-wi">
            <div class="pi-wi-head">
                <span class="pi-wi-idx">#${i + 1}</span>
                <span class="pi-wi-name">${escapeHtml(wi.comment || '(未命名)')}</span>
                ${wi.constant ? '<span class="pi-tag pi-tag-blue">常驻</span>' : ''}
                ${wi.selective ? '<span class="pi-tag pi-tag-purple">选择性</span>' : ''}
                <span class="pi-wi-tokens">~${wi.tokens}t</span>
            </div>
            <div class="pi-wi-meta">
                <span>📚 ${escapeHtml(wi.world)}</span>
                <span>🔑 ${escapeHtml(wi.key)}</span>
                ${wi.depth !== null ? `<span>⬇ depth ${wi.depth}</span>` : ''}
                ${wi.order !== null ? `<span>order ${wi.order}</span>` : ''}
                ${wi.position !== null ? `<span>pos ${wi.position}</span>` : ''}
            </div>
            <div class="pi-wi-content">${escapeHtml(wi.content)}${wi.content.length >= 500 ? '…' : ''}</div>
        </div>
    `).join('');
    el.innerHTML = `<div class="pi-wi-list">${rows}</div>`;
}

function renderDepth(el, snap) {
    // depth_prompt 在 chat 数组里通常会被识别成 source = 'depth_prompt' 或 name='depth_prompt'
    const depths = snap.messages.filter(m =>
        m.source === 'depth_prompt' ||
        m.name === 'depth_prompt' ||
        (m.name || '').toLowerCase().includes('depth')
    );

    // 同时把 WI 里 position=深度位置的也算上
    const wiDepth = (snap.activatedWI || []).filter(w => w.depth !== null && w.depth !== undefined);

    if (depths.length === 0 && wiDepth.length === 0) {
        el.innerHTML = '<div class="pi-empty">本次没有 depth 注入</div>';
        return;
    }

    // 用消息流的相对位置画一条简易楼层图
    const total = snap.messageCount;
    const blocks = snap.messages.map((m, i) => {
        const meta = SOURCE_META[m.source] || SOURCE_META.unknown;
        const isDepth = m.source === 'depth_prompt' || (m.name || '').toLowerCase().includes('depth');
        return `<div class="pi-floor ${isDepth ? 'pi-floor-depth' : ''}" 
                     style="background:${meta.color}"
                     title="#${i} ${m.role} ${meta.label} ${m.tokens}t"></div>`;
    }).join('');

    const depthList = depths.map(m => `
        <div class="pi-depth-item">
            <div class="pi-depth-head">楼层 #${m.index} / 共 ${total} · ${m.role} · ~${m.tokens}t</div>
            <div class="pi-depth-content">${escapeHtml(m.content)}</div>
        </div>
    `).join('');

    const wiDepthList = wiDepth.map(w => `
        <div class="pi-depth-item">
            <div class="pi-depth-head">[世界书 @depth ${w.depth}] ${escapeHtml(w.comment)}</div>
            <div class="pi-depth-content">${escapeHtml(w.content)}</div>
        </div>
    `).join('');

    el.innerHTML = `
        <div class="pi-floors">
            <div class="pi-floor-label">↑ 顶部 (system/preset)</div>
            <div class="pi-floor-bar">${blocks}</div>
            <div class="pi-floor-label">↓ 底部 (最近消息)</div>
        </div>
        <h4 class="pi-h4">Depth Prompt 注入</h4>
        ${depthList || '<div class="pi-empty">无</div>'}
        <h4 class="pi-h4">世界书 @depth 注入</h4>
        ${wiDepthList || '<div class="pi-empty">无</div>'}
    `;
}

function renderRaw(el, snap) {
    const json = JSON.stringify(
        snap.fetchPayload ? snap.fetchPayload.raw : snap.messages,
        null, 2
    );
    el.innerHTML = `
        <div class="pi-raw-actions">
            <button class="pi-btn" id="pi-copy">复制 JSON</button>
            <button class="pi-btn" id="pi-download">下载 .json</button>
            <span class="pi-hint">${snap.fetchPayload ? '来自 fetch 拦截' : '来自事件钩子'}</span>
        </div>
        <pre class="pi-raw">${escapeHtml(json)}</pre>
    `;
    el.querySelector('#pi-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(json);
        toast('已复制');
    });
    el.querySelector('#pi-download').addEventListener('click', () => {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `prompt-snapshot-${snap.timestamp}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });
}

function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function toast(msg) {
    const t = document.createElement('div');
    t.className = 'pi-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1500);
}

// ============ /diag 斜杠命令 ============
function registerSlashCommand() {
    try {
        const ctx = getContext();
        if (ctx && ctx.SlashCommandParser && ctx.SlashCommand) {
            ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
                name: 'diag',
                callback: () => {
                    const panel = document.getElementById('prompt-inspector-panel');
                    if (panel) {
                        panel.classList.toggle('pi-collapsed');
                    }
                    return '';
                },
                helpString: '打开/关闭提示词诊断面板',
            }));
        }
    } catch (e) {
        console.warn('[PromptInspector] 注册 /diag 失败（不影响使用）:', e);
    }
}

// ============ 启动 ============
jQuery(async () => {
    try {
        injectPanel();
        attachEvents();
        attachFetchHook();
        registerSlashCommand();
        renderPanel();
        console.log('[PromptInspector] 已加载 ✨');
    } catch (e) {
        console.error('[PromptInspector] 启动失败:', e);
    }
});
            // 异步的，这里同步路径用估算
        }
    } catch (e) { /* 忽略 */ }
    return estimateTokens(text);
}

// ============ 消息来源识别 ============
// 根据消息内容/role 推断来源类别
function classifySource(msg, index, total) {
    const content = (msg.content || '').toString();
    const role = msg.role;

    // ST 在 CHAT_COMPLETION_PROMPT_READY 的 chat 数组里通常带有 identifier 或 name 字段
    if (msg.identifier) {
        const id = msg.identifier.toLowerCase();
        if (id.includes('main') || id.includes('system')) return 'preset_main';
        if (id.includes('jailbreak') || id.includes('nsfw')) return 'preset_jb';
        if (id.includes('persona')) return 'persona';
        if (id.includes('charDescription') || id.includes('char_desc')) return 'char_card';
        if (id.includes('charPersonality')) return 'char_card';
        if (id.includes('scenario')) return 'char_card';
        if (id.includes('worldInfo') || id.includes('world_info')) return 'world_info';
        if (id.includes('dialogueExamples')) return 'char_examples';
        if (id.includes('chatHistory')) return 'history';
        if (id.includes('newChat') || id.includes('newGroup')) return 'preset_other';
        return 'preset_other';
    }

    // 标记字段
    if (msg.name === 'depth_prompt' || (msg.extra && msg.extra.depth_prompt)) {
        return 'depth_prompt';
    }

    // 历史消息特征：靠后 + assistant/user 交替
    const isLatter = index >= total - 30;
    if (isLatter && (role === 'user' || role === 'assistant')) {
        return 'history';
    }

    if (role === 'system') return 'preset_other';
    return role === 'user' ? 'history' : 'history';
}

const SOURCE_META = {
    preset_main:    { label: '预设·主提示',  color: '#6366f1' },
    preset_jb:      { label: '预设·越狱',    color: '#ec4899' },
    preset_other:   { label: '预设·其他',    color: '#8b5cf6' },
    char_card:      { label: '角色卡',       color: '#f59e0b' },
    char_examples:  { label: '对话示例',     color: '#fbbf24' },
    persona:        { label: '玩家人设',     color: '#10b981' },
    world_info:     { label: '世界书',       color: '#3b82f6' },
    depth_prompt:   { label: 'Depth Prompt', color: '#ef4444' },
    history:        { label: '聊天历史',     color: '#64748b' },
    unknown:        { label: '未分类',       color: '#9ca3af' },
};

// ============ 构建快照 ============
function buildSnapshot(chatArray) {
    const messages = (chatArray || []).map((msg, i, arr) => {
        const source = classifySource(msg, i, arr.length) || 'unknown';
        const content = (msg.content || '').toString();
        const tokens = countTokens(content);
        return {
            index: i,
            role: msg.role,
            name: msg.name || msg.identifier || '',
            content,
            tokens,
            source,
            preview: content.slice(0, 200),
        };
    });

    // Token 按来源汇总
    const tokensBySource = {};
    let totalTokens = 0;
    for (const m of messages) {
        tokensBySource[m.source] = (tokensBySource[m.source] || 0) + m.tokens;
        totalTokens += m.tokens;
    }

    return {
        timestamp: Date.now(),
        messages,
        tokensBySource,
        totalTokens,
        messageCount: messages.length,
        activatedWI: [...state.activatedWI],
    };
}

// ============ 事件钩子 ============
function attachEvents() {
    // 主入口：CC 模式下，prompt 组装完成、即将发送
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (data) => {
        try {
            // data.chat 是发送给 API 的 messages 数组
            const chatArray = data?.chat || data?.messages || [];
            const snap = buildSnapshot(chatArray);
            snap.dryRun = !!data?.dryRun;

            state.lastSnapshot = snap;
            state.history.unshift(snap);
            if (state.history.length > MAX_HISTORY) state.history.pop();

            renderPanel();
            if (state.autoOpen) openPanel();
        } catch (e) {
            console.error('[PromptInspector] CHAT_COMPLETION_PROMPT_READY 处理失败:', e);
        }
    });

    // 文本补全模式：generate_after_data
    if (event_types.GENERATE_AFTER_DATA) {
        eventSource.on(event_types.GENERATE_AFTER_DATA, (data) => {
            try {
                // 文本补全模式下没有 messages 数组，用 prompt 字符串包一层
                if (!data) return;
                const fakeChat = [{
                    role: 'system',
                    content: data.prompt || JSON.stringify(data),
                    identifier: 'tc_combined',
                }];
                const snap = buildSnapshot(fakeChat);
                snap.textCompletion = true;
                state.lastSnapshot = snap;
                state.history.unshift(snap);
                if (state.history.length > MAX_HISTORY) state.history.pop();
                renderPanel();
            } catch (e) {
                console.error('[PromptInspector] GENERATE_AFTER_DATA 处理失败:', e);
            }
        });
    }

    // 世界书命中
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, (entries) => {
        try {
            state.activatedWI = (entries || []).map(e => ({
                world: e.world || e.book || '',
                comment: e.comment || '',
                key: Array.isArray(e.key) ? e.key.join(', ') : (e.key || ''),
                content: (e.content || '').slice(0, 500),
                depth: e.depth ?? null,
                order: e.order ?? null,
                position: e.position ?? null,
                constant: !!e.constant,
                selective: !!e.selective,
                tokens: countTokens(e.content || ''),
            }));
        } catch (e) {
            console.error('[PromptInspector] WORLD_INFO_ACTIVATED 处理失败:', e);
        }
    });

    // 生成结束，刷新一次（确保 WI 数据合并到当前快照）
    eventSource.on(event_types.GENERATION_STARTED, () => {
        if (state.lastSnapshot) {
            state.lastSnapshot.activatedWI = [...state.activatedWI];
            renderPanel();
        }
    });
}

// ============ Fetch 拦截兜底 ============
// 抓真实发往 /api/backends/chat-completions/generate 的 payload，对照事件数据
function attachFetchHook() {
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
        try {
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
            const opts = args[1];
            if (url && typeof url === 'string' &&
                (url.includes('/chat-completions/generate') ||
                 url.includes('/openai/generate') ||
                 url.includes('/generate'))) {
                if (opts && opts.body) {
                    try {
                        const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
                        state.interceptedPayload = {
                            url,
                            timestamp: Date.now(),
                            messages: body.messages || null,
                            prompt: body.prompt || null,
                            model: body.model || null,
                            max_tokens: body.max_tokens || body.max_length,
                            temperature: body.temperature,
                            raw: body,
                        };
                        // 如果事件没拿到（极少数情况），用 fetch 数据补
                        if (!state.lastSnapshot && body.messages) {
                            const snap = buildSnapshot(body.messages);
                            snap.fromFetch = true;
                            state.lastSnapshot = snap;
                            state.history.unshift(snap);
                            renderPanel();
                        } else if (state.lastSnapshot) {
                            state.lastSnapshot.fetchPayload = state.interceptedPayload;
                            renderPanel();
                        }
                    } catch (e) { /* 非 JSON body 忽略 */ }
                }
            }
        } catch (e) { /* 不影响请求 */ }
        return origFetch.apply(this, args);
    };
}

// ============ UI ============
function injectPanel() {
    if (document.getElementById('prompt-inspector-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'prompt-inspector-panel';
    panel.className = 'pi-panel pi-collapsed';
    panel.innerHTML = `
        <div class="pi-header">
            <span class="pi-title">🔍 Prompt Inspector</span>
            <div class="pi-controls">
                <label class="pi-toggle" title="发送后自动展开">
                    <input type="checkbox" id="pi-auto-open"> 自动
                </label>
                <select id="pi-history" class="pi-select" title="历史快照"></select>
                <button id="pi-collapse" class="pi-btn-icon" title="折叠/展开">▸</button>
            </div>
        </div>
        <div class="pi-body">
            <div class="pi-tabs">
                <button class="pi-tab pi-tab-active" data-tab="overview">概览</button>
                <button class="pi-tab" data-tab="messages">消息流</button>
                <button class="pi-tab" data-tab="worldinfo">世界书</button>
                <button class="pi-tab" data-tab="depth">Depth</button>
                <button class="pi-tab" data-tab="raw">原始</button>
            </div>
            <div class="pi-content">
                <div class="pi-tab-pane pi-pane-active" data-pane="overview"></div>
                <div class="pi-tab-pane" data-pane="messages"></div>
                <div class="pi-tab-pane" data-pane="worldinfo"></div>
                <div class="pi-tab-pane" data-pane="depth"></div>
                <div class="pi-tab-pane" data-pane="raw"></div>
            </div>
        </div>
    `;
    document.body.appendChild(panel);

    // 折叠/展开
    panel.querySelector('#pi-collapse').addEventListener('click', () => {
        panel.classList.toggle('pi-collapsed');
        state.panelOpen = !panel.classList.contains('pi-collapsed');
    });
    panel.querySelector('.pi-header').addEventListener('dblclick', () => {
        panel.classList.toggle('pi-collapsed');
        state.panelOpen = !panel.classList.contains('pi-collapsed');
    });

    // 自动开关
    panel.querySelector('#pi-auto-open').addEventListener('change', (e) => {
        state.autoOpen = e.target.checked;
    });

    // tab 切换
    panel.querySelectorAll('.pi-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            panel.querySelectorAll('.pi-tab').forEach(t => t.classList.remove('pi-tab-active'));
            panel.querySelectorAll('.pi-tab-pane').forEach(p => p.classList.remove('pi-pane-active'));
            tab.classList.add('pi-tab-active');
            const target = tab.dataset.tab;
            panel.querySelector(`.pi-tab-pane[data-pane="${target}"]`).classList.add('pi-pane-active');
        });
    });

    // 历史选择
    panel.querySelector('#pi-history').addEventListener('change', (e) => {
        const idx = parseInt(e.target.value, 10);
        if (!isNaN(idx) && state.history[idx]) {
            state.lastSnapshot = state.history[idx];
            renderPanel();
        }
    });

    // 拖动支持（简易）
    makeDraggable(panel);

    // 拖到右侧使其常驻
    panel.style.right = '10px';
    panel.style.top = '60px';
}

function openPanel() {
    const panel = document.getElementById('prompt-inspector-panel');
    if (panel) {
        panel.classList.remove('pi-collapsed');
        state.panelOpen = true;
    }
}

function makeDraggable(el) {
    const header = el.querySelector('.pi-header');
    let offX = 0, offY = 0, dragging = false;
    header.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'LABEL') return;
        dragging = true;
        offX = e.clientX - el.offsetLeft;
        offY = e.clientY - el.offsetTop;
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        el.style.left = (e.clientX - offX) + 'px';
        el.style.top = (e.clientY - offY) + 'px';
        el.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
}

function renderPanel() {
    const panel = document.getElementById('prompt-inspector-panel');
    if (!panel) return;
    const snap = state.lastSnapshot;

    // 历史下拉
    const sel = panel.querySelector('#pi-history');
    sel.innerHTML = state.history.map((s, i) => {
        const t = new Date(s.timestamp);
        const time = t.toLocaleTimeString('zh-CN', { hour12: false });
        return `<option value="${i}">${i === 0 ? '● ' : ''}${time} · ${s.totalTokens}t</option>`;
    }).join('');

    if (!snap) {
        panel.querySelector('[data-pane="overview"]').innerHTML = '<div class="pi-empty">还没有数据，发送一条消息试试 ✨</div>';
        return;
    }

    renderOverview(panel.querySelector('[data-pane="overview"]'), snap);
    renderMessages(panel.querySelector('[data-pane="messages"]'), snap);
    renderWorldInfo(panel.querySelector('[data-pane="worldinfo"]'), snap);
    renderDepth(panel.querySelector('[data-pane="depth"]'), snap);
    renderRaw(panel.querySelector('[data-pane="raw"]'), snap);
}

function renderOverview(el, snap) {
    const total = snap.totalTokens || 1;
    const sources = Object.entries(snap.tokensBySource).sort((a, b) => b[1] - a[1]);

    // SVG 饼图
    let cumAngle = 0;
    const radius = 70, cx = 80, cy = 80;
    const slices = sources.map(([key, val]) => {
        const angle = (val / total) * 2 * Math.PI;
        const x1 = cx + radius * Math.cos(cumAngle);
        const y1 = cy + radius * Math.sin(cumAngle);
        cumAngle += angle;
        const x2 = cx + radius * Math.cos(cumAngle);
        const y2 = cy + radius * Math.sin(cumAngle);
        const large = angle > Math.PI ? 1 : 0;
        const meta = SOURCE_META[key] || SOURCE_META.unknown;
        return `<path d="M${cx},${cy} L${x1},${y1} A${radius},${radius} 0 ${large} 1 ${x2},${y2} Z" fill="${meta.color}" stroke="#1a1a1a" stroke-width="1"/>`;
    }).join('');

    const legend = sources.map(([key, val]) => {
        const meta = SOURCE_META[key] || SOURCE_META.unknown;
        const pct = ((val / total) * 100).toFixed(1);
        return `<div class="pi-legend-row">
            <span class="pi-legend-dot" style="background:${meta.color}"></span>
            <span class="pi-legend-label">${meta.label}</span>
            <span class="pi-legend-tokens">${val}t</span>
            <span class="pi-legend-pct">${pct}%</span>
        </div>`;
    }).join('');

    const meta = `
        <div class="pi-meta">
            <div><b>消息数</b>: ${snap.messageCount}</div>
            <div><b>总 token</b>: ~${snap.totalTokens} <span class="pi-hint">(估算)</span></div>
            <div><b>WI 命中</b>: ${snap.activatedWI.length}</div>
            ${snap.dryRun ? '<div class="pi-tag">DRY RUN</div>' : ''}
            ${snap.fromFetch ? '<div class="pi-tag pi-tag-warn">FETCH 兜底</div>' : ''}
            ${snap.textCompletion ? '<div class="pi-tag">文本补全</div>' : ''}
        </div>
    `;

    el.innerHTML = `
        ${meta}
        <div class="pi-pie-wrap">
            <svg viewBox="0 0 160 160" class="pi-pie">${slices}</svg>
            <div class="pi-legend">${legend}</div>
        </div>
    `;
}

function renderMessages(el, snap) {
    const rows = snap.messages.map(m => {
        const meta = SOURCE_META[m.source] || SOURCE_META.unknown;
        return `
            <div class="pi-msg" data-idx="${m.index}">
                <div class="pi-msg-head">
                    <span class="pi-msg-idx">#${m.index}</span>
                    <span class="pi-msg-role pi-role-${m.role}">${m.role}</span>
                    <span class="pi-msg-source" style="background:${meta.color}22;color:${meta.color};border-color:${meta.color}">${meta.label}</span>
                    ${m.name ? `<span class="pi-msg-name">${escapeHtml(m.name)}</span>` : ''}
                    <span class="pi-msg-tokens">~${m.tokens}t</span>
                </div>
                <div class="pi-msg-preview">${escapeHtml(m.preview)}${m.content.length > 200 ? '…' : ''}</div>
            </div>
        `;
    }).join('');
    el.innerHTML = `<div class="pi-msg-list">${rows}</div>`;

    // 点击展开全文
    el.querySelectorAll('.pi-msg').forEach(node => {
        node.addEventListener('click', () => {
            const idx = parseInt(node.dataset.idx, 10);
            const m = snap.messages[idx];
            if (!m) return;
            const preview = node.querySelector('.pi-msg-preview');
            if (preview.classList.contains('pi-msg-full')) {
                preview.classList.remove('pi-msg-full');
                preview.textContent = m.preview + (m.content.length > 200 ? '…' : '');
            } else {
                preview.classList.add('pi-msg-full');
                preview.textContent = m.content;
            }
        });
    });
}

function renderWorldInfo(el, snap) {
    if (!snap.activatedWI || snap.activatedWI.length === 0) {
        el.innerHTML = '<div class="pi-empty">本次没有世界书条目命中</div>';
        return;
    }
    const rows = snap.activatedWI.map((wi, i) => `
        <div class="pi-wi">
            <div class="pi-wi-head">
                <span class="pi-wi-idx">#${i + 1}</span>
                <span class="pi-wi-name">${escapeHtml(wi.comment || '(未命名)')}</span>
                ${wi.constant ? '<span class="pi-tag pi-tag-blue">常驻</span>' : ''}
                ${wi.selective ? '<span class="pi-tag pi-tag-purple">选择性</span>' : ''}
                <span class="pi-wi-tokens">~${wi.tokens}t</span>
            </div>
            <div class="pi-wi-meta">
                <span>📚 ${escapeHtml(wi.world)}</span>
                <span>🔑 ${escapeHtml(wi.key)}</span>
                ${wi.depth !== null ? `<span>⬇ depth ${wi.depth}</span>` : ''}
                ${wi.order !== null ? `<span>order ${wi.order}</span>` : ''}
                ${wi.position !== null ? `<span>pos ${wi.position}</span>` : ''}
            </div>
            <div class="pi-wi-content">${escapeHtml(wi.content)}${wi.content.length >= 500 ? '…' : ''}</div>
        </div>
    `).join('');
    el.innerHTML = `<div class="pi-wi-list">${rows}</div>`;
}

function renderDepth(el, snap) {
    // depth_prompt 在 chat 数组里通常会被识别成 source = 'depth_prompt' 或 name='depth_prompt'
    const depths = snap.messages.filter(m =>
        m.source === 'depth_prompt' ||
        m.name === 'depth_prompt' ||
        (m.name || '').toLowerCase().includes('depth')
    );

    // 同时把 WI 里 position=深度位置的也算上
    const wiDepth = (snap.activatedWI || []).filter(w => w.depth !== null && w.depth !== undefined);

    if (depths.length === 0 && wiDepth.length === 0) {
        el.innerHTML = '<div class="pi-empty">本次没有 depth 注入</div>';
        return;
    }

    // 用消息流的相对位置画一条简易楼层图
    const total = snap.messageCount;
    const blocks = snap.messages.map((m, i) => {
        const meta = SOURCE_META[m.source] || SOURCE_META.unknown;
        const isDepth = m.source === 'depth_prompt' || (m.name || '').toLowerCase().includes('depth');
        return `<div class="pi-floor ${isDepth ? 'pi-floor-depth' : ''}" 
                     style="background:${meta.color}"
                     title="#${i} ${m.role} ${meta.label} ${m.tokens}t"></div>`;
    }).join('');

    const depthList = depths.map(m => `
        <div class="pi-depth-item">
            <div class="pi-depth-head">楼层 #${m.index} / 共 ${total} · ${m.role} · ~${m.tokens}t</div>
            <div class="pi-depth-content">${escapeHtml(m.content)}</div>
        </div>
    `).join('');

    const wiDepthList = wiDepth.map(w => `
        <div class="pi-depth-item">
            <div class="pi-depth-head">[世界书 @depth ${w.depth}] ${escapeHtml(w.comment)}</div>
            <div class="pi-depth-content">${escapeHtml(w.content)}</div>
        </div>
    `).join('');

    el.innerHTML = `
        <div class="pi-floors">
            <div class="pi-floor-label">↑ 顶部 (system/preset)</div>
            <div class="pi-floor-bar">${blocks}</div>
            <div class="pi-floor-label">↓ 底部 (最近消息)</div>
        </div>
        <h4 class="pi-h4">Depth Prompt 注入</h4>
        ${depthList || '<div class="pi-empty">无</div>'}
        <h4 class="pi-h4">世界书 @depth 注入</h4>
        ${wiDepthList || '<div class="pi-empty">无</div>'}
    `;
}

function renderRaw(el, snap) {
    const json = JSON.stringify(
        snap.fetchPayload ? snap.fetchPayload.raw : snap.messages,
        null, 2
    );
    el.innerHTML = `
        <div class="pi-raw-actions">
            <button class="pi-btn" id="pi-copy">复制 JSON</button>
            <button class="pi-btn" id="pi-download">下载 .json</button>
            <span class="pi-hint">${snap.fetchPayload ? '来自 fetch 拦截' : '来自事件钩子'}</span>
        </div>
        <pre class="pi-raw">${escapeHtml(json)}</pre>
    `;
    el.querySelector('#pi-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(json);
        toast('已复制');
    });
    el.querySelector('#pi-download').addEventListener('click', () => {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `prompt-snapshot-${snap.timestamp}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });
}

function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function toast(msg) {
    const t = document.createElement('div');
    t.className = 'pi-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1500);
}

// ============ /diag 斜杠命令 ============
function registerSlashCommand() {
    try {
        const ctx = getContext();
        if (ctx && ctx.SlashCommandParser && ctx.SlashCommand) {
            ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
                name: 'diag',
                callback: () => {
                    const panel = document.getElementById('prompt-inspector-panel');
                    if (panel) {
                        panel.classList.toggle('pi-collapsed');
                    }
                    return '';
                },
                helpString: '打开/关闭提示词诊断面板',
            }));
        }
    } catch (e) {
        console.warn('[PromptInspector] 注册 /diag 失败（不影响使用）:', e);
    }
}

// ============ 启动 ============
jQuery(async () => {
    try {
        injectPanel();
        attachEvents();
        attachFetchHook();
        registerSlashCommand();
        renderPanel();
        console.log('[PromptInspector] 已加载 ✨');
    } catch (e) {
        console.error('[PromptInspector] 启动失败:', e);
    }
});
