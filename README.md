# WebDAV Chat Backup for SillyTavern

一个用于 SillyTavern 的 WebDAV 聊天备份扩展。它把前端扩展面板和一个很小的服务端辅助插件组合在一起，避免浏览器直连 WebDAV 时常见的跨域问题。

扩展入口在 SillyTavern 的“扩展”页面内。WebDAV 地址由用户手动填写，不内置坚果云、InfiniCLOUD 或其他服务商的固定地址。

## 功能

- 手动测试 WebDAV 连接。
- 手动备份聊天数据到 WebDAV。
- 从 WebDAV 备份包恢复数据。
- 自动备份，支持按时间间隔和聊天变化触发检查。
- 自动清理旧备份，可设置保留数量。
- 配置持久化保存，WebDAV 授权密码通过 SillyTavern secrets 保存。
- 支持坚果云、InfiniCLOUD，以及兼容标准 WebDAV 的服务。

## 备份范围

可在扩展面板中勾选以下内容：

- `chats`：单人聊天记录。
- `group chats` 和 `groups`：群聊记录与群组信息。
- `characters`：角色卡文件。
- `worlds`：世界书。
- `settings.json`：SillyTavern 设置。

简单说，角色卡是“角色本身的设定文件”，单人聊天是“你和某个角色聊出来的历史记录”。备份角色卡不会等于备份聊天记录，备份单人聊天也不会自动包含角色卡，所以建议两项都勾上。

## 安装

这个扩展包含两部分：前端扩展和服务端辅助插件。

仓库地址： [https://github.com/ZZZa-o/sillytavern-webdav-chat-backup](https://github.com/ZZZa-o/sillytavern-webdav-chat-backup)

1. 把本项目整个文件夹复制到：

   ```text
   SillyTavern/public/scripts/extensions/third-party/webdav-chat-backup
   ```

2. 把 `server-plugin/index.js` 复制到：

   ```text
   SillyTavern/plugins/webdav-chat-backup/index.js
   ```

3. 打开 SillyTavern 的 `config.yaml`，确认服务端插件已启用：

   ```yaml
   enableServerPlugins: true
   ```

4. 重启 SillyTavern。

5. 进入 SillyTavern 的“扩展”页面，展开 `WebDAV Chat Backup`。

## 使用

1. 填写 WebDAV 地址、用户名、远端目录。
2. 在“授权密码”中填写 WebDAV 授权密码，然后点击“保存密码”。
3. 点击“保存配置”。
4. 点击“测试连接”，确认远端目录可读写。
5. 勾选需要备份的内容。
6. 点击“立即备份”，或开启“自动备份”。
7. 需要恢复时，点击“刷新清单”，选择备份包，再点击“恢复”。

恢复时，如果本地已有同名文件，扩展会先在 SillyTavern 的 backups 目录下创建保护副本，再写入恢复文件。

## 坚果云使用说明

坚果云需要使用 WebDAV 的“应用授权密码”，不要直接使用账号登录密码。

1. 注册并登录坚果云账号。
2. 在坚果云账号设置中找到“安全选项”或“第三方应用管理”相关页面。
3. 添加应用并生成应用授权密码。
4. 在本扩展里手动填写坚果云提供的 WebDAV 地址、账号和应用授权密码。

坚果云官方教程： [如何开启 WebDAV 并获取应用授权密码](https://help.jianguoyun.com/?p=2064)

本扩展不会内置坚果云地址。请以坚果云页面显示的 WebDAV 地址为准，复制后手动填入。

## InfiniCLOUD 和其他 WebDAV 服务

InfiniCLOUD、NAS、Nextcloud、ownCloud、Cloudreve 等服务只要提供标准 WebDAV 地址，通常都可以使用。

请在服务商页面获取：

- WebDAV 地址
- 用户名
- WebDAV 密码或应用授权密码

然后在扩展中手动填写。

## 数据与安全

- 普通配置保存在 SillyTavern 的扩展设置中。
- WebDAV 授权密码保存在 SillyTavern secrets 中，键名为 `webdav_chat_backup_password`。
- 备份包不会包含 `secrets.json`。
- 备份包是 `.zip` 文件，文件名格式为 `st-webdav-backup-YYYYMMDD-HHMMSS.zip`。
- 删除远端备份只会删除当前远端目录下由本扩展创建的备份包。

## 常见问题

### 为什么需要服务端辅助插件？

很多 WebDAV 服务不允许浏览器网页直接跨域访问。服务端辅助插件会让 SillyTavern 后端代为访问 WebDAV，这样连接测试、备份和恢复会更稳定。

### WebDAV 地址要怎么填？

填服务商提供的完整 WebDAV 地址即可。本扩展不提供内置地址模板，也不会自动猜测服务商地址。

### 备份失败怎么办？

先点击“测试连接”。如果测试失败，通常是 WebDAV 地址、用户名、授权密码或远端目录权限有问题。坚果云用户请确认使用的是应用授权密码。

### 恢复会覆盖我的本地文件吗？

会写入备份包中的文件。写入前如果发现同名文件，会先创建本地保护副本，方便你在需要时手动找回。
