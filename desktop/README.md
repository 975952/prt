# Windows 桌面端

[返回项目首页](../README.md) · [完整开发指南](../docs/开发指南.md)

桌面版使用 Rust 提供本地服务，Tao 管理系统窗口，Wry / WebView2 加载前端。`public/` 在编译时内嵌，同时提供 `prt-setup.exe` 安装版与 `prt.exe` 便携版，用户无需安装 Node.js。

## 构建

需要 Windows x64、Rust stable MSVC 工具链、Visual Studio C++ Build Tools / Windows SDK 和 WebView2 Runtime。从仓库根运行：

```powershell
cmd /d /c desktop\build.bat
```

脚本会重新触发资源内嵌，执行 release 构建，将 EXE 复制到仓库根与桌面，并校验哈希。它不会关闭运行中的阅读器。文件占用时请按提示重试。

前端修改和新增文件都需要重建。测试必须使用最新 EXE 的隔离副本，不能用旧产物验证新源码。

构建安装包使用 Inno Setup 6.7.3，与发布流程的固定版本一致。从仓库根运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/build-setup.ps1
```

产物在 `dist/`。安装包使用固定 AppId 支持原位升级，按当前用户安装到 `%LOCALAPPDATA%\Programs\prt`，创建开始菜单与可选桌面快捷方式。安装目录包含程序、安装模式标记、许可证与卸载文件，卸载不遍历或删除个人数据目录。

[发布流程](../.github/workflows/release.yml) 使用固定版本的官方下载及 SHA256、数字签名校验。手动运行只生成构建产物；推送匹配 Cargo 版本的 `v*` 标签后创建草稿 Release，检查说明和资产后再公开发布。重复运行不会覆盖已有 Release，也不会清理历史版本。

## 运行

```text
prt.exe                 启动桌面阅读器
prt.exe --console       显示调试日志
prt.exe --port 8899      从指定端口开始寻找可用端口
prt.exe --help           查看支持的参数
```

本地服务仅绑定 `127.0.0.1`，默认从 8787 寻找可用端口。EXE 旁存在安装器创建的 `prt-installed.flag` 时，数据使用 `%LOCALAPPDATA%\prt\data`，论文使用系统“文档”下的 `prt\papers`；无标记的便携版使用 EXE 旁的 `data/` 和 `papers/`。`PRT_PAPERS_DIR`、`PRT_DATA_DIR` 优先覆盖默认路径，测试必须指向隔离目录。Node 开发服务继续使用项目目录或上述环境变量。

`prt.exe --storage-info --report <绝对路径.json>` 可输出实际目录而不启动服务。显式执行 `prt.exe --migrate-from <旧便携目录> --report <绝对路径.json> --silent` 会向空目标复制 `data/` 与 `papers/`，成功返回 0；错误返回非 0，并在报告中说明原因，不包含配置内容。源与目标正在使用、路径重叠、目标非空及未完成迁移都需按错误提示处理，不能通过覆盖跳过。

应用支持多标签和多个系统窗口，共享论文与数据目录，各窗口保留阅读位置和布局。详情见 [多窗口阅读](../docs/多窗口阅读.md)。

## 代码入口

| 路径 | 职责 |
| --- | --- |
| [src/main.rs](src/main.rs) | 程序启动、参数与服务生命周期 |
| [src/api.rs](src/api.rs) | 论文、配置、会话等 HTTP 接口 |
| [src/chat.rs](src/chat.rs) | 模型请求转发与流式响应 |
| [src/model_profiles.rs](src/model_profiles.rs) | 多模型配置与密钥保留规则 |
| [src/assets.rs](src/assets.rs) | 静态资源内嵌 |
| [Cargo.toml](Cargo.toml) | 构建依赖与编译配置 |

与 [Node 服务](../server.js) 保持接口契约一致。配置读取不回传真实密钥，写入要保留既有的原子保存、数据隔离和请求边界。

## 验证

```powershell
npm --prefix test ci
node test/reader-layout.mjs --desktop
node test/product-ux.mjs --desktop
node test/theme.mjs --desktop
```

上述命令在仓库根执行，由 Edge 连接隔离 EXE 服务。原生窗口行为另用 `node test/multiwindow.mjs` 验证。更多测试入口与限制见 [开发指南](../docs/开发指南.md#测试)。
