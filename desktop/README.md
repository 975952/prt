# Windows 桌面端

[返回项目首页](../README.md) · [完整开发指南](../docs/开发指南.md)

桌面版使用 Rust 提供本地服务，Tao 管理系统窗口，Wry / WebView2 加载前端。`public/` 在编译时内嵌，交付一个 `prt.exe`，用户无需安装 Node.js。

## 构建

需要 Windows x64、Rust stable MSVC 工具链、Visual Studio C++ Build Tools / Windows SDK 和 WebView2 Runtime。从仓库根运行：

```powershell
cmd /d /c desktop\build.bat
```

脚本会重新触发资源内嵌，执行 release 构建，将 EXE 复制到仓库根与桌面，并校验哈希。它不会关闭运行中的阅读器。文件占用时请按提示重试。

前端修改和新增文件都需要重建。测试必须使用最新 EXE 的隔离副本，不能用旧产物验证新源码。

## 运行

```text
prt.exe                 启动桌面阅读器
prt.exe --console       显示调试日志
prt.exe --port 8899      从指定端口开始寻找可用端口
prt.exe --help           查看支持的参数
```

本地服务仅绑定 `127.0.0.1`，默认从 8787 寻找可用端口。`papers/` 和 `data/` 相对 EXE 所在目录解析；设置 `PRT_PAPERS_DIR`、`PRT_DATA_DIR` 可覆盖，测试必须指向隔离目录。

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
