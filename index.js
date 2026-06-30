import {
    extension_settings,
} from '/scripts/extensions.js';

import {
    eventSource,
    event_types,
    getRequestHeaders,
    saveSettingsDebounced,
} from '/script.js';

const EXT_ID = 'webdav-chat-backup';
const SECRET_KEY = 'webdav_chat_backup_password';
const API_BASE = '/api/plugins/webdav-chat-backup';

const DEFAULT_SETTINGS = {
    url: '',
    username: '',
    remotePath: 'SillyTavern-WebDAV-Backup',
    includeChats: true,
    includeGroupChats: true,
    includeCharacters: true,
    includeWorlds: true,
    includeSettings: true,
    retention: 10,
    autoEnabled: false,
    autoIntervalHours: 6,
    autoOnChatEvents: true,
    passwordSaved: false,
    lastBackupAt: '',
    lastBackupFile: '',
    lastStatus: '',
};

let autoTimer = null;
let autoDebounce = null;
let busy = false;

function copyDefaults() {
    return typeof structuredClone === 'function'
        ? structuredClone(DEFAULT_SETTINGS)
        : JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function getSettings() {
    if (!extension_settings[EXT_ID]) {
        extension_settings[EXT_ID] = copyDefaults();
    }
    const settings = extension_settings[EXT_ID];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined || settings[key] === null) {
            settings[key] = value;
        }
    }
    return settings;
}

function escHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function prettyDate(value) {
    if (!value) return '尚未备份';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
}

function prettyBytes(size) {
    const num = Number(size) || 0;
    if (num < 1024) return `${num} B`;
    if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
    if (num < 1024 * 1024 * 1024) return `${(num / 1024 / 1024).toFixed(1)} MB`;
    return `${(num / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function buildPanel() {
    const s = getSettings();
    const lastStatus = String(s.lastStatus || '').trim();
    const html = `
        <div id="wdcb-root" class="wdcb-shell">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b><i class="fa-solid fa-cloud-arrow-up"></i> WebDAV Chat Backup</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="wdcb-statusline">
                        <span id="wdcb-helper-status" class="wdcb-pill is-muted">检查中</span>
                        <span id="wdcb-password-state" class="wdcb-pill ${s.passwordSaved ? 'is-ok' : 'is-muted'}">${s.passwordSaved ? '密码已保存' : '未保存密码'}</span>
                        <span id="wdcb-last-backup" class="wdcb-pill is-muted">${escHtml(prettyDate(s.lastBackupAt))}</span>
                    </div>

                    <section class="wdcb-section">
                        <div class="wdcb-grid">
                            <label class="wdcb-field">
                                <span>WebDAV 地址</span>
                                <input id="wdcb-url" class="text_pole" type="url" value="${escHtml(s.url)}" placeholder="https://example.com/dav/">
                            </label>
                            <label class="wdcb-field">
                                <span>用户名</span>
                                <input id="wdcb-username" class="text_pole" type="text" value="${escHtml(s.username)}" autocomplete="username">
                            </label>
                            <label class="wdcb-field">
                                <span>远端目录</span>
                                <input id="wdcb-remote-path" class="text_pole" type="text" value="${escHtml(s.remotePath)}" placeholder="SillyTavern-WebDAV-Backup">
                            </label>
                            <label class="wdcb-field">
                                <span>授权密码</span>
                                <input id="wdcb-password" class="text_pole" type="password" value="" autocomplete="new-password" placeholder="${s.passwordSaved ? '留空则继续使用已保存密码' : '输入后点击保存密码'}">
                            </label>
                        </div>
                        <div class="wdcb-actions">
                            <button id="wdcb-save-config" class="menu_button"><i class="fa-solid fa-floppy-disk"></i><span>保存配置</span></button>
                            <button id="wdcb-save-password" class="menu_button"><i class="fa-solid fa-key"></i><span>保存密码</span></button>
                            <button id="wdcb-clear-password" class="menu_button"><i class="fa-solid fa-eraser"></i><span>清除密码</span></button>
                            <button id="wdcb-test" class="menu_button"><i class="fa-solid fa-plug-circle-check"></i><span>测试连接</span></button>
                        </div>
                    </section>

                    <section class="wdcb-section">
                        <div class="wdcb-section-title">备份内容</div>
                        <div class="wdcb-checks">
                            <label class="checkbox_label"><input id="wdcb-include-chats" type="checkbox" ${s.includeChats ? 'checked' : ''}><span>单人聊天</span></label>
                            <label class="checkbox_label"><input id="wdcb-include-group-chats" type="checkbox" ${s.includeGroupChats ? 'checked' : ''}><span>群聊记录与群组</span></label>
                            <label class="checkbox_label"><input id="wdcb-include-characters" type="checkbox" ${s.includeCharacters ? 'checked' : ''}><span>角色卡</span></label>
                            <label class="checkbox_label"><input id="wdcb-include-worlds" type="checkbox" ${s.includeWorlds ? 'checked' : ''}><span>世界书</span></label>
                            <label class="checkbox_label"><input id="wdcb-include-settings" type="checkbox" ${s.includeSettings ? 'checked' : ''}><span>设置</span></label>
                        </div>
                        <div class="wdcb-actions">
                            <button id="wdcb-backup-now" class="menu_button primary"><i class="fa-solid fa-cloud-arrow-up"></i><span>立即备份</span></button>
                            <button id="wdcb-refresh-list" class="menu_button"><i class="fa-solid fa-rotate"></i><span>刷新清单</span></button>
                        </div>
                    </section>

                    <section class="wdcb-section">
                        <div class="wdcb-section-title">恢复与管理</div>
                        <div class="wdcb-restore-row">
                            <select id="wdcb-backup-list" class="text_pole">
                                <option value="">尚未读取备份清单</option>
                            </select>
                            <button id="wdcb-restore" class="menu_button"><i class="fa-solid fa-clock-rotate-left"></i><span>恢复</span></button>
                            <button id="wdcb-delete" class="menu_button danger"><i class="fa-solid fa-trash-can"></i><span>删除</span></button>
                        </div>
                        <div id="wdcb-backup-meta" class="wdcb-meta"></div>
                    </section>

                    <section class="wdcb-section">
                        <div class="wdcb-section-title">自动备份</div>
                        <div class="wdcb-auto-row">
                            <label class="checkbox_label"><input id="wdcb-auto-enabled" type="checkbox" ${s.autoEnabled ? 'checked' : ''}><span>启用</span></label>
                            <label class="checkbox_label"><input id="wdcb-auto-events" type="checkbox" ${s.autoOnChatEvents ? 'checked' : ''}><span>聊天变化后检查</span></label>
                            <label class="wdcb-inline-field">
                                <span>间隔</span>
                                <input id="wdcb-auto-hours" class="text_pole" type="number" min="0.25" max="168" step="0.25" value="${escHtml(s.autoIntervalHours)}">
                                <span>小时</span>
                            </label>
                            <label class="wdcb-inline-field">
                                <span>保留</span>
                                <input id="wdcb-retention" class="text_pole" type="number" min="1" max="200" step="1" value="${escHtml(s.retention)}">
                                <span>份</span>
                            </label>
                        </div>
                    </section>

                    <div id="wdcb-status" class="wdcb-status ${lastStatus ? 'is-info' : ''}">${escHtml(lastStatus)}</div>
                </div>
            </div>
        </div>
    `;
    $('#extensions_settings2').append(html);
}

function readFormIntoSettings() {
    const s = getSettings();
    s.url = $('#wdcb-url').val()?.toString().trim() || '';
    s.username = $('#wdcb-username').val()?.toString().trim() || '';
    s.remotePath = $('#wdcb-remote-path').val()?.toString().trim() || '';
    s.includeChats = $('#wdcb-include-chats').prop('checked');
    s.includeGroupChats = $('#wdcb-include-group-chats').prop('checked');
    s.includeCharacters = $('#wdcb-include-characters').prop('checked');
    s.includeWorlds = $('#wdcb-include-worlds').prop('checked');
    s.includeSettings = $('#wdcb-include-settings').prop('checked');
    s.autoEnabled = $('#wdcb-auto-enabled').prop('checked');
    s.autoOnChatEvents = $('#wdcb-auto-events').prop('checked');
    s.autoIntervalHours = Math.max(0.25, Number($('#wdcb-auto-hours').val()) || DEFAULT_SETTINGS.autoIntervalHours);
    s.retention = Math.max(1, Math.floor(Number($('#wdcb-retention').val()) || DEFAULT_SETTINGS.retention));
    saveSettingsDebounced();
    syncAutoTimer();
    return s;
}

function getPayloadSettings() {
    const s = getSettings();
    return {
        url: s.url,
        username: s.username,
        remotePath: s.remotePath,
        include: {
            chats: !!s.includeChats,
            groupChats: !!s.includeGroupChats,
            characters: !!s.includeCharacters,
            worlds: !!s.includeWorlds,
            settings: !!s.includeSettings,
        },
        retention: Math.max(1, Math.floor(Number(s.retention) || DEFAULT_SETTINGS.retention)),
    };
}

function setStatus(message, type = 'info') {
    const text = String(message || '').trim();
    const s = getSettings();
    s.lastStatus = text;
    saveSettingsDebounced();
    const status = $('#wdcb-status')
        .removeClass('is-info is-ok is-warn is-error')
        .text(text);
    if (text) {
        status.addClass(`is-${type}`);
    }
}

function setBusy(value) {
    busy = value;
    $('#wdcb-root button, #wdcb-root input, #wdcb-root select').prop('disabled', value);
}

function notify(type, message) {
    if (window.toastr && typeof window.toastr[type] === 'function') {
        window.toastr[type](message);
    }
}

async function api(action, payload = {}) {
    const response = await fetch(`${API_BASE}/${action}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(payload),
    });
    const text = await response.text();
    let data = {};
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { error: text };
    }
    if (!response.ok || data.ok === false) {
        throw new Error(data.error || response.statusText || '请求失败');
    }
    return data;
}

async function checkHelper() {
    try {
        const data = await api('status');
        $('#wdcb-helper-status')
            .removeClass('is-muted is-error')
            .addClass('is-ok')
            .text('后端已连接');
        const s = getSettings();
        s.passwordSaved = !!data.hasPassword || !!s.passwordSaved;
        $('#wdcb-password-state')
            .toggleClass('is-ok', !!s.passwordSaved)
            .toggleClass('is-muted', !s.passwordSaved)
            .text(s.passwordSaved ? '密码已保存' : '未保存密码');
        saveSettingsDebounced();
        return true;
    } catch {
        $('#wdcb-helper-status')
            .removeClass('is-muted is-ok')
            .addClass('is-error')
            .text('后端未加载');
        return false;
    }
}

async function savePassword() {
    const value = $('#wdcb-password').val()?.toString() ?? '';
    if (!value) {
        setStatus('没有输入新密码，已保留当前密码。', 'warn');
        return;
    }
    setBusy(true);
    try {
        const response = await fetch('/api/secrets/write', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ key: SECRET_KEY, value, label: 'WebDAV Chat Backup' }),
        });
        if (!response.ok) throw new Error('密码保存失败');
        const s = getSettings();
        s.passwordSaved = true;
        $('#wdcb-password').val('');
        $('#wdcb-password-state').removeClass('is-muted').addClass('is-ok').text('密码已保存');
        saveSettingsDebounced();
        setStatus('密码已保存。', 'ok');
        notify('success', 'WebDAV 密码已保存');
        await checkHelper();
    } catch (error) {
        setStatus(error.message || '密码保存失败。', 'error');
    } finally {
        setBusy(false);
    }
}

async function clearPassword() {
    if (!confirm('清除已保存的 WebDAV 授权密码？')) return;
    setBusy(true);
    try {
        const response = await fetch('/api/secrets/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ key: SECRET_KEY }),
        });
        if (!response.ok && response.status !== 204) throw new Error('密码清除失败');
        const s = getSettings();
        s.passwordSaved = false;
        $('#wdcb-password-state').removeClass('is-ok').addClass('is-muted').text('未保存密码');
        saveSettingsDebounced();
        setStatus('密码已清除。', 'ok');
        notify('info', 'WebDAV 密码已清除');
    } catch (error) {
        setStatus(error.message || '密码清除失败。', 'error');
    } finally {
        setBusy(false);
    }
}

async function testConnection() {
    readFormIntoSettings();
    setBusy(true);
    setStatus('正在测试连接...', 'info');
    try {
        const data = await api('test', { settings: getPayloadSettings() });
        setStatus(data.message || '连接测试通过。', 'ok');
        notify('success', 'WebDAV 连接测试通过');
        await refreshList(false);
    } catch (error) {
        setStatus(error.message || '连接测试失败。', 'error');
    } finally {
        setBusy(false);
    }
}

async function runBackup(reason = 'manual') {
    readFormIntoSettings();
    setBusy(true);
    setStatus(reason === 'manual' ? '正在创建备份...' : '自动备份进行中...', 'info');
    try {
        const data = await api('backup', { settings: getPayloadSettings(), reason });
        const s = getSettings();
        s.lastBackupAt = data.createdAt || new Date().toISOString();
        s.lastBackupFile = data.fileName || '';
        $('#wdcb-last-backup').text(prettyDate(s.lastBackupAt));
        saveSettingsDebounced();
        setStatus(`备份完成：${data.fileName || ''}（${prettyBytes(data.size)}，${data.files || 0} 个文件）`, 'ok');
        notify('success', 'WebDAV 备份完成');
        await refreshList(false);
    } catch (error) {
        setStatus(error.message || '备份失败。', 'error');
    } finally {
        setBusy(false);
    }
}

function renderBackupList(items = []) {
    const select = $('#wdcb-backup-list');
    select.empty();
    if (!items.length) {
        select.append('<option value="">没有找到备份</option>');
        $('#wdcb-backup-meta').text('');
        return;
    }
    for (const item of items) {
        const label = `${item.name}  ·  ${prettyBytes(item.size)}  ·  ${prettyDate(item.modified)}`;
        select.append(`<option value="${escHtml(item.name)}" data-size="${escHtml(item.size)}" data-modified="${escHtml(item.modified)}">${escHtml(label)}</option>`);
    }
    renderSelectedBackupMeta();
}

function renderSelectedBackupMeta() {
    const option = $('#wdcb-backup-list option:selected');
    if (!option.val()) {
        $('#wdcb-backup-meta').text('');
        return;
    }
    $('#wdcb-backup-meta').text(`${option.val()} / ${prettyBytes(option.data('size'))} / ${prettyDate(option.data('modified'))}`);
}

async function refreshList(showBusy = true) {
    readFormIntoSettings();
    if (showBusy) {
        setBusy(true);
        setStatus('正在读取备份清单...', 'info');
    }
    try {
        const data = await api('list', { settings: getPayloadSettings() });
        renderBackupList(data.items || []);
        if (showBusy) setStatus(`已读取 ${data.items?.length || 0} 个备份。`, 'ok');
    } catch (error) {
        if (showBusy) setStatus(error.message || '读取备份清单失败。', 'error');
        else console.warn('[WebDAV Chat Backup] list failed:', error);
    } finally {
        if (showBusy) setBusy(false);
    }
}

async function restoreBackup() {
    readFormIntoSettings();
    const fileName = $('#wdcb-backup-list').val()?.toString();
    if (!fileName) {
        setStatus('请选择一个备份。', 'warn');
        return;
    }
    if (!confirm(`恢复备份：${fileName}？同名文件会先保存本地保护副本。`)) return;
    setBusy(true);
    setStatus('正在恢复备份...', 'info');
    try {
        const data = await api('restore', { settings: getPayloadSettings(), fileName });
        setStatus(`恢复完成：写入 ${data.restored || 0} 个文件，保护副本 ${data.protected || 0} 个。`, 'ok');
        notify('success', 'WebDAV 备份已恢复');
    } catch (error) {
        setStatus(error.message || '恢复失败。', 'error');
    } finally {
        setBusy(false);
    }
}

async function deleteBackup() {
    readFormIntoSettings();
    const fileName = $('#wdcb-backup-list').val()?.toString();
    if (!fileName) {
        setStatus('请选择一个备份。', 'warn');
        return;
    }
    if (!confirm(`删除远端备份：${fileName}？`)) return;
    setBusy(true);
    setStatus('正在删除远端备份...', 'info');
    try {
        await api('delete', { settings: getPayloadSettings(), fileName });
        setStatus('远端备份已删除。', 'ok');
        notify('info', '远端备份已删除');
        await refreshList(false);
    } catch (error) {
        setStatus(error.message || '删除失败。', 'error');
    } finally {
        setBusy(false);
    }
}

function getAutoIntervalMs() {
    const hours = Math.max(0.25, Number(getSettings().autoIntervalHours) || DEFAULT_SETTINGS.autoIntervalHours);
    return hours * 60 * 60 * 1000;
}

async function maybeAutoBackup(reason) {
    const s = getSettings();
    if (!s.autoEnabled || busy || !s.url) return;
    const last = s.lastBackupAt ? new Date(s.lastBackupAt).getTime() : 0;
    if (Date.now() - last < getAutoIntervalMs()) return;
    await runBackup(reason);
}

function queueAutoBackup(reason) {
    const s = getSettings();
    if (!s.autoEnabled || !s.autoOnChatEvents) return;
    clearTimeout(autoDebounce);
    autoDebounce = setTimeout(() => maybeAutoBackup(reason), 5000);
}

function syncAutoTimer() {
    clearInterval(autoTimer);
    autoTimer = null;
    if (!getSettings().autoEnabled) return;
    autoTimer = setInterval(() => maybeAutoBackup('auto'), 60 * 1000);
}

function bindEvents() {
    $('#wdcb-save-config').on('click', () => {
        readFormIntoSettings();
        setStatus('配置已保存。', 'ok');
    });
    $('#wdcb-save-password').on('click', savePassword);
    $('#wdcb-clear-password').on('click', clearPassword);
    $('#wdcb-test').on('click', testConnection);
    $('#wdcb-backup-now').on('click', () => runBackup('manual'));
    $('#wdcb-refresh-list').on('click', () => refreshList(true));
    $('#wdcb-restore').on('click', restoreBackup);
    $('#wdcb-delete').on('click', deleteBackup);
    $('#wdcb-backup-list').on('change', renderSelectedBackupMeta);
    $('#wdcb-root input[type="checkbox"], #wdcb-auto-hours, #wdcb-retention, #wdcb-url, #wdcb-username, #wdcb-remote-path')
        .on('change', readFormIntoSettings);

    const chatEvents = [
        event_types.MESSAGE_SENT,
        event_types.MESSAGE_RECEIVED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_DELETED,
        event_types.MESSAGE_SWIPED,
        event_types.CHAT_CHANGED,
        event_types.CHAT_CREATED,
        event_types.GROUP_CHAT_CREATED,
    ].filter(Boolean);

    for (const event of chatEvents) {
        eventSource.on(event, () => queueAutoBackup('auto-chat'));
    }

    window.addEventListener('pagehide', () => {
        if (getSettings().autoEnabled) {
            maybeAutoBackup('auto-pagehide');
        }
    });
}

jQuery(async () => {
    getSettings();
    buildPanel();
    bindEvents();
    syncAutoTimer();
    await checkHelper();
});
