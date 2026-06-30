const fs = require('node:fs');
const path = require('node:path');
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');

const info = {
    id: 'webdav-chat-backup',
    name: 'WebDAV Chat Backup',
    description: 'Back up and restore SillyTavern chats, group chats, characters, worlds, and settings to WebDAV.',
};

const SECRET_KEY = 'webdav_chat_backup_password';
const MANIFEST_FILE = 'webdav-chat-backup-manifest.json';
const BACKUP_PREFIX = 'st-webdav-backup-';

function init(router) {
    router.post('/status', (request, response) => {
        response.json({
            ok: true,
            helper: true,
            hasPassword: !!readWebDavPassword(request.user.directories),
        });
    });

    router.post('/test', async (request, response) => {
        await handle(response, async () => {
            const config = resolveConfig(request);
            await ensureRemoteRoot(config);
            const marker = `.webdav-chat-backup-test-${Date.now()}.txt`;
            await webDavRequest(config, [marker], {
                method: 'PUT',
                body: Buffer.from(`SillyTavern WebDAV test ${new Date().toISOString()}\n`, 'utf8'),
                headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            }, [200, 201, 204]);
            try {
                await webDavRequest(config, [marker], { method: 'DELETE' }, [200, 202, 204, 404]);
            } catch (error) {
                return { message: `连接可用，测试文件已上传；删除测试文件失败：${error.message}` };
            }
            return { message: '连接可用，远端目录可读写。' };
        });
    });

    router.post('/list', async (request, response) => {
        await handle(response, async () => {
            const config = resolveConfig(request);
            const items = await listBackups(config);
            return { items };
        });
    });

    router.post('/backup', async (request, response) => {
        await handle(response, async () => {
            const config = resolveConfig(request);
            await ensureRemoteRoot(config);
            const { zipBuffer, manifest } = await createBackupArchive(request.user, config.include, request.body?.reason);
            const fileName = `${BACKUP_PREFIX}${timestampForFile()}.zip`;
            await webDavRequest(config, [fileName], {
                method: 'PUT',
                body: zipBuffer,
                headers: { 'Content-Type': 'application/zip' },
            }, [200, 201, 204]);
            await pruneBackups(config);
            return {
                fileName,
                createdAt: manifest.createdAt,
                files: manifest.files.length,
                size: zipBuffer.length,
            };
        });
    });

    router.post('/restore', async (request, response) => {
        await handle(response, async () => {
            const config = resolveConfig(request);
            const fileName = sanitizeBackupFileName(request.body?.fileName);
            const remote = await webDavRequest(config, [fileName], { method: 'GET' }, [200]);
            const buffer = Buffer.from(await remote.arrayBuffer());
            const result = await restoreArchive(request.user.directories, buffer, config.include);
            return result;
        });
    });

    router.post('/delete', async (request, response) => {
        await handle(response, async () => {
            const config = resolveConfig(request);
            const fileName = sanitizeBackupFileName(request.body?.fileName);
            await webDavRequest(config, [fileName], { method: 'DELETE' }, [200, 202, 204, 404]);
            return { deleted: fileName };
        });
    });
}

async function handle(response, fn) {
    try {
        const result = await fn();
        response.json({ ok: true, ...result });
    } catch (error) {
        console.error('[WebDAV Chat Backup]', error);
        response.status(500).json({ ok: false, error: error.message || String(error) });
    }
}

function resolveConfig(request) {
    const body = request.body?.settings || {};
    const url = String(body.url || '').trim();
    if (!url) {
        throw new Error('请先填写 WebDAV 地址。');
    }
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error();
        }
    } catch {
        throw new Error('WebDAV 地址格式不正确。');
    }

    const password = readWebDavPassword(request.user.directories);
    const include = normalizeInclude(body.include || {});
    if (!Object.values(include).some(Boolean)) {
        throw new Error('请至少选择一项备份内容。');
    }

    return {
        url,
        username: String(body.username || '').trim(),
        password,
        remotePath: String(body.remotePath || '').trim(),
        include,
        retention: Math.max(1, Math.min(200, Number.parseInt(body.retention, 10) || 10)),
    };
}

function normalizeInclude(include) {
    return {
        chats: include.chats !== false,
        groupChats: include.groupChats !== false,
        characters: include.characters !== false,
        worlds: include.worlds !== false,
        settings: include.settings !== false,
    };
}

function readWebDavPassword(directories) {
    const file = path.join(directories.root, 'secrets.json');
    if (!fs.existsSync(file)) return '';
    try {
        const secrets = JSON.parse(fs.readFileSync(file, 'utf8'));
        const values = secrets[SECRET_KEY];
        if (!Array.isArray(values) || values.length === 0) return '';
        const active = values.find(item => item && item.active) || values[values.length - 1];
        return typeof active?.value === 'string' ? active.value : '';
    } catch {
        return '';
    }
}

function splitRemotePath(remotePath) {
    return String(remotePath || '')
        .replace(/\\/g, '/')
        .split('/')
        .map(part => part.trim())
        .filter(Boolean)
        .filter(part => part !== '.' && part !== '..');
}

function splitUrlPath(pathname) {
    return String(pathname || '/')
        .split('/')
        .filter(Boolean)
        .map(segment => {
            try {
                return decodeURIComponent(segment);
            } catch {
                return segment;
            }
        });
}

function buildRemoteUrl(config, extraSegments = [], includeRemotePath = true) {
    const target = new URL(config.url);
    const baseSegments = splitUrlPath(target.pathname);
    const segments = includeRemotePath
        ? [...splitRemotePath(config.remotePath), ...extraSegments]
        : extraSegments;
    target.pathname = `/${[...baseSegments, ...segments].map(segment => encodeURIComponent(segment)).join('/')}`;
    return target.toString();
}

function authHeaders(config) {
    const headers = {};
    if (config.username || config.password) {
        headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`;
    }
    return headers;
}

async function webDavRequest(config, extraSegments, options, expectedStatuses) {
    const url = buildRemoteUrl(config, extraSegments, options.includeRemotePath !== false);
    const headers = {
        ...authHeaders(config),
        ...(options.headers || {}),
    };
    const response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body,
    });
    if (!expectedStatuses.includes(response.status)) {
        let text = '';
        try {
            text = await response.text();
        } catch {
            text = '';
        }
        const detail = text ? `：${text.slice(0, 300)}` : '';
        throw new Error(`WebDAV ${options.method} 失败 (${response.status})${detail}`);
    }
    return response;
}

async function ensureRemoteRoot(config) {
    const parts = splitRemotePath(config.remotePath);
    for (let index = 1; index <= parts.length; index++) {
        const current = parts.slice(0, index);
        await webDavRequest(config, current, { method: 'MKCOL', includeRemotePath: false }, [200, 201, 204, 405]);
    }
}

async function listBackups(config) {
    await ensureRemoteRoot(config);
    const body = [
        '<?xml version="1.0" encoding="utf-8" ?>',
        '<d:propfind xmlns:d="DAV:">',
        '<d:prop><d:displayname/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop>',
        '</d:propfind>',
    ].join('');
    const response = await webDavRequest(config, [], {
        method: 'PROPFIND',
        headers: {
            Depth: '1',
            'Content-Type': 'application/xml; charset=utf-8',
        },
        body,
    }, [207, 200]);
    const xml = await response.text();
    return parsePropfind(xml)
        .filter(item => item.name.endsWith('.zip') && item.name.startsWith(BACKUP_PREFIX))
        .sort((a, b) => new Date(b.modified || 0).getTime() - new Date(a.modified || 0).getTime());
}

function parsePropfind(xml) {
    const responses = xml.match(/<[^>]*:?response[\s\S]*?<\/[^>]*:?response>/gi) || [];
    const items = [];
    for (const block of responses) {
        const href = firstXmlValue(block, 'href');
        if (!href) continue;
        const name = nameFromHref(href);
        if (!name || name.endsWith('/')) continue;
        const typeBlock = firstXmlValue(block, 'resourcetype') || '';
        if (/collection/i.test(typeBlock)) continue;
        items.push({
            name,
            size: Number(firstXmlValue(block, 'getcontentlength') || 0),
            modified: firstXmlValue(block, 'getlastmodified') || '',
        });
    }
    return items;
}

function firstXmlValue(block, tag) {
    const match = block.match(new RegExp(`<[^>]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[^>]*:?${tag}>`, 'i'));
    return match ? decodeXml(match[1].trim()) : '';
}

function decodeXml(value) {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function nameFromHref(href) {
    try {
        const parsed = new URL(href, 'http://placeholder.local');
        const segments = parsed.pathname.split('/').filter(Boolean);
        return decodeURIComponent(segments.at(-1) || '');
    } catch {
        const segments = href.split('/').filter(Boolean);
        try {
            return decodeURIComponent(segments.at(-1) || '');
        } catch {
            return segments.at(-1) || '';
        }
    }
}

async function createBackupArchive(user, include, reason) {
    const entries = {};
    const manifest = {
        type: 'sillytavern-webdav-chat-backup',
        version: 1,
        createdAt: new Date().toISOString(),
        reason: reason || 'manual',
        user: user.profile?.handle || 'unknown',
        include,
        files: [],
    };

    async function addFile(source, relativePath) {
        const stats = await fs.promises.stat(source);
        if (!stats.isFile()) return;
        const normalized = relativePath.replace(/\\/g, '/');
        entries[normalized] = new Uint8Array(await fs.promises.readFile(source));
        manifest.files.push({
            path: normalized,
            size: stats.size,
            mtime: stats.mtime.toISOString(),
        });
    }

    async function addDirectory(sourceDir, targetDir) {
        if (!fs.existsSync(sourceDir)) return;
        const dirents = await fs.promises.readdir(sourceDir, { withFileTypes: true });
        for (const dirent of dirents) {
            const source = path.join(sourceDir, dirent.name);
            const target = `${targetDir}/${dirent.name}`;
            if (dirent.isDirectory()) {
                await addDirectory(source, target);
            } else if (dirent.isFile()) {
                await addFile(source, target);
            }
        }
    }

    if (include.chats) {
        await addDirectory(user.directories.chats, 'chats');
    }
    if (include.groupChats) {
        await addDirectory(user.directories.groupChats, 'group chats');
        await addDirectory(user.directories.groups, 'groups');
    }
    if (include.characters) {
        await addDirectory(user.directories.characters, 'characters');
    }
    if (include.worlds) {
        await addDirectory(user.directories.worlds, 'worlds');
    }
    if (include.settings) {
        const settingsPath = path.join(user.directories.root, 'settings.json');
        if (fs.existsSync(settingsPath)) {
            await addFile(settingsPath, 'settings.json');
        }
    }

    entries[MANIFEST_FILE] = strToU8(JSON.stringify(manifest, null, 2));
    const zipBuffer = Buffer.from(zipSync(entries, { level: 6 }));
    return { zipBuffer, manifest };
}

async function pruneBackups(config) {
    const items = await listBackups(config);
    const stale = items.slice(config.retention);
    for (const item of stale) {
        try {
            await webDavRequest(config, [item.name], { method: 'DELETE' }, [200, 202, 204, 404]);
        } catch (error) {
            console.warn('[WebDAV Chat Backup] Failed to prune backup:', item.name, error.message);
        }
    }
}

function sanitizeBackupFileName(input) {
    const name = path.posix.basename(String(input || '').replace(/\\/g, '/'));
    if (!name || !name.endsWith('.zip') || name.includes('..')) {
        throw new Error('备份文件名不正确。');
    }
    return name;
}

async function restoreArchive(directories, buffer, include) {
    const archive = unzipSync(new Uint8Array(buffer));
    const manifestEntry = archive[MANIFEST_FILE];
    if (manifestEntry) {
        try {
            const manifest = JSON.parse(strFromU8(manifestEntry));
            if (manifest.type !== 'sillytavern-webdav-chat-backup') {
                throw new Error();
            }
        } catch {
            throw new Error('备份清单无法识别。');
        }
    }

    const protectionRoot = path.join(directories.backups, `webdav-restore-${timestampForFile()}`);
    let restored = 0;
    let protectedCount = 0;

    for (const [entryPath, data] of Object.entries(archive)) {
        const normalized = normalizeZipPath(entryPath);
        if (!normalized || normalized === MANIFEST_FILE || normalized.endsWith('/')) continue;
        const target = resolveRestoreTarget(directories, normalized, include);
        if (!target) continue;
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        if (fs.existsSync(target)) {
            const protectPath = path.join(protectionRoot, normalized);
            await fs.promises.mkdir(path.dirname(protectPath), { recursive: true });
            await fs.promises.copyFile(target, protectPath);
            protectedCount++;
        }
        await fs.promises.writeFile(target, Buffer.from(data));
        restored++;
    }

    return {
        restored,
        protected: protectedCount,
        protectionDir: protectedCount > 0 ? protectionRoot : '',
    };
}

function normalizeZipPath(entryPath) {
    const normalized = String(entryPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.some(part => part === '.' || part === '..')) {
        throw new Error(`备份包内路径不安全：${entryPath}`);
    }
    return parts.join('/');
}

function resolveRestoreTarget(directories, entryPath, include) {
    const pairs = [
        ['chats/', directories.chats, include.chats],
        ['group chats/', directories.groupChats, include.groupChats],
        ['groups/', directories.groups, include.groupChats],
        ['characters/', directories.characters, include.characters],
        ['worlds/', directories.worlds, include.worlds],
    ];
    if (entryPath === 'settings.json') {
        if (!include.settings) return null;
        const target = path.resolve(directories.root, 'settings.json');
        ensureInside(directories.root, target);
        return target;
    }
    for (const [prefix, base, enabled] of pairs) {
        if (!enabled || !entryPath.startsWith(prefix)) continue;
        const target = path.resolve(base, entryPath.slice(prefix.length));
        ensureInside(base, target);
        return target;
    }
    return null;
}

function ensureInside(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`目标路径越界：${child}`);
    }
}

function timestampForFile() {
    const date = new Date();
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

module.exports = {
    info,
    init,
};
