[README.md](https://github.com/user-attachments/files/33473412/README.md)
# dsh-plugin-session-delete

给 DeepSeek Harness 增加「删除会话」能力的插件（Host + 浏览器两端，零依赖、免构建）。

## 效果

侧边栏会话行的「⋯」菜单里多出一项 **删除会话**（危险色，排在「归档会话」之后）。
选择后弹出确认框，确认后该会话被永久删除：

1. **拒绝删除当前进程里已打开的会话** —— 先切走该会话再删。
2. 从工作区成员表、置顶表、归档表中摘除该会话。
3. 删除它的投影缓存 checkpoint（\`session_projcache\` 域，走 storage domain 的写链）。
4. 删除它的持久化目录
   \`$DSH_HOME/sessions/<project-dir>/<session-id>/\`（含 \`session.vN.jsonl.zstd\` 与 \`session.lock\`），
   并在目录变空时清理项目目录。
5. 通知浏览器刷新会话列表，该行随即消失。

删除不可恢复；附件仓库是内容寻址的，其他会话完全不受影响。

## 已安装位置（本机）

- 插件包：\`%USERPROFILE%\\.dsh\\profiles\\desktop\\plugins\\dsh-plugin-session-delete\\\`
- 注册行：\`%USERPROFILE%\\.dsh\\profiles\\desktop\\cordis.patch.yml\` 末尾：

  \`\`\`yaml
  - insert:
      - id: session-delete
        name: './plugins/dsh-plugin-session-delete/lib/index.js'
  \`\`\`

profile 配置默认热加载，通常新增行会即时生效；**若侧边栏暂时看不到「删除会话」，完全退出并重新打开 DeepSeek Harness 即可。**

## 卸载 / 回滚

1. 删除 \`cordis.patch.yml\` 末尾那段 \`- insert: … session-delete\`（安装时的原文备份是
   \`cordis.patch.yml.bak-before-session-delete\`，可直接覆盖回去）。
2. 删除 \`%USERPROFILE%\\.dsh\\profiles\\desktop\\plugins\\dsh-plugin-session-delete\\\` 整个目录。
3. 重启应用。

卸载不会残留任何插件自有的持久状态。

## 手动安装（换机器时）

### 方式 A：复制进 profile，用相对路径注册（本机采用的方式）

\`\`\`powershell
$profile = "$env:USERPROFILE\\.dsh\\profiles\\desktop"
New-Item -ItemType Directory -Force "$profile\\plugins" | Out-Null
Copy-Item -Recurse -Force "<本仓库>\\dsh-plugin-session-delete" "$profile\\plugins\\"
# 然后在 $profile\\cordis.patch.yml 末尾追加上面的 insert 段
\`\`\`

### 方式 B：不复制，直接引用本目录的绝对路径

在 \`cordis.patch.yml\` 末尾追加（正斜杠绝对路径可用）：

\`\`\`yaml
- id: session-delete
  name: 'C:/Users/Administrator/Desktop/学习笔记/dsh-plugin-session-delete/lib/index.js'
\`\`\`

### 方式 C：作为本地 bundle 交给插件管理器

侧边栏 **Plugins** 页 → 安装 → 填本目录绝对路径。插件管理器会读本地
\`package.json\`（本包声明了 \`dsh.bundle.patch\`），把它装进 profile 的
\`node_modules\` 并加入 \`dsh.profile.bundles\`。此方式需要 pnpm 能访问该目录。

## 结构

| 文件 | 作用 |
| --- | --- |
| \`lib/index.js\` | Host 半边：Cordis Service \`sessionDelete\`，唯一 Remote 端点 \`sessionDelete/deleteSession\`，由 \`@Remote\` 标记经 Gateway 的 SRC 模式发现，无需任何生成描述符 |
| \`lib/client.js\` | 浏览器半边：往 \`sidebar.workspaces.session.menu.item\` 注册菜单项，往 \`shell.overlay\` 注册确认框与结果提示，通过 \`ctx.connection.rpc\` 调 Host，成功后 \`ctx.sessions.refresh()\` |
| \`cordis.patch.yml\` | 作为 bundle 安装时插入 Host 行 |
| \`package.json\` | \`dsh.bundle.patch\` + \`dsh.client\`（platform: web）声明 |

## 实现要点

- **不用构建**：Host 半边是普通 ESM，\`@Remote\` 标记用装饰器的函数形态在模块加载时补打
  （\`Remote("deleteSession")(fn, context)\` + 手动跑 \`addInitializer\`），
  浏览器半边就是 \`window.__ModuleLoader__.load({ id, factory })\` 形式的懒 CJS 包。
- **浏览器半边只需要平台种子模块**（\`react\`、\`@deepseek-ai/dsh-client-store\`、
  \`@deepseek-ai/dsh-client-ui-primitives\`），因此 \`dsh.client.external\` 为空。
- **路径来源**：优先用 \`sessionPersistence.locate(header).path\`（权威）；
  退化为读 \`sessionPersistence.root\` 并扫描 \`<root>/*/<encoded-id>\`，编码规则与
  \`dsh-session-persistence-jsonl\` 的 \`encodeSegment\` 一致。

## 限制

- 只能删除**当前进程未打开**的会话；这是为了避免在会话仍持有写句柄时删除日志。
- 会话正在运行（有轮次/子代理/后台任务）时，若它已被打开，同样会被拒绝。
- 删除只作用于会话数据，不会删除工作区目录本身。
