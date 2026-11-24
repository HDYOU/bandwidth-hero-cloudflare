# Bandwidth Hero Proxy —— Cloudflare Workers 版

把 [HDYOU/bandwidth-hero-vercel](https://github.com/HDYOU/bandwidth-hero-vercel) 这套「图片在线压缩代理」搬到 Cloudflare Workers 上，接口与 Bandwidth Hero 浏览器插件完全兼容。

原项目是基于 Node + Express + [sharp](https://github.com/lovell/sharp) 的服务，**没法原样部署到 Cloudflare**：sharp 是原生二进制，Workers 的 V8 isolate 加载不了；`lzma-native`、`zstd-codec` 同理。所以这份代码把 sharp 换成 WASM 版编解码器（`@jsquash/*`，Squoosh 的 WebAssembly 构建），其余行为尽量对齐原项目。

## 接口

```
GET /?url=<encodeURIComponent(原图地址)>
    &l=<质量 10-100，默认 40>
    &bw=0            # 0 = 保持彩色；不传或非 0 = 灰度
    &jpeg=1          # 输出 JPEG；默认输出 WebP
    &format=webp|jpg
    &headers=<base64(JSON)>   # 附加到回源请求的头
```

响应头沿用原项目：

- `x-original-size`：原图字节数
- `x-bytes-saved`：节省的字节数
- `x-proxy-bypass: 1`：没压缩、原样回源
- 失败时 302 跳回原图，插件会自己降级

## 部署（约 3 分钟）

```bash
npm install
npx wrangler login          # 浏览器里点授权
npm run dev                 # 本地 http://localhost:8787 先验证
npm run deploy              # 发布到 Cloudflare
```

`deploy` 成功后会打印形如：

```
https://bandwidth-hero-proxy.<你的子域>.workers.dev
```

自测一条：

```bash
curl "https://bandwidth-hero-proxy.<子域>.workers.dev/?url=$(python3 -c "import urllib.parse;print(urllib.parse.quote('https://picsum.photos/1200/800.jpg',safe=''))")&l=40" -o test.webp
```

预期：73 KB 的 JPEG 变成约 17 KB 的 WebP，响应头里 `x-bytes-saved` 约 55000。

然后在 Bandwidth Hero 插件的设置里，把 proxy 地址填成这个 Workers 域名即可（插件默认用的是公共代理）。

### 其他部署方式

- **Git 集成**：仓库推到 GitHub，Cloudflare 控制台 → Workers & Pages → 连接仓库，构建命令 `npm ci`，部署命令 `npx wrangler deploy`，之后每次 push 自动发布。
- **自定义域名**：wrangler.toml 里加 `routes = [{ pattern = "img.example.com", custom_domain = true }]`，或在控制台绑定。
- **Cloudflare Containers（另一条路）**：付费套餐下可以把原 Node 镜像整个跑在容器里，几乎零改动、功能最全，但有冷启动延迟，成本也高。想保留 sharp 的全部能力再考虑它。

## 配置

`wrangler.toml`：

```toml
[vars]
MIN_COMPRESS_LENGTH = "2048"   # 小于该字节数的图不压缩，直接回源
```

部署后也可以在控制台 → Settings → Variables 改成 `wrangler secret put`/变量，无需改代码。

## 和原项目的差异

| 项目 | 原版（Node + sharp） | 这版（Workers + WASM） |
| --- | --- | --- |
| 依赖 | 原生 sharp，需容器/VM | 纯 WASM，边缘节点直跑 |
| 支持输入 | JPEG/PNG/WebP/AVIF/GIF/TIFF/SVG… | JPEG/PNG/WebP/AVIF |
| 动图（GIF/APNG/动图 WebP） | 用 sharp animated 压 | **直接回源**，不压（避免动画变静帧） |
| 其他格式（GIF 静图、BMP、ICO、SVG、TIFF） | 处理 | 直接回源，`x-proxy-bypass: 1` |
| EXIF 方向 | sharp 自动转正 | 不处理（依赖原图本身方向正确） |
| 上游 lzma/zstd 压缩响应 | 自己解压 | 不处理；gzip/br 由 Workers `fetch` 自动解压 |
| 尺寸 | 保持原尺寸，只降质量+可选灰度 | 同左 |
| 缓存 | 无 | 走 `caches.default` 边缘缓存（默认 24h） |

## 成本与限制（重要）

- **CPU 时间**：Workers 免费版每请求只有 10 ms CPU，解一张大图再编码很可能超（报错 1102）。实际用起来建议开 **Workers Paid（$5/月，30 s CPU）**，或只处理小图。
- 单请求内存上限 128 MB，超大图（几千万像素）会失败 → 自动 302 回源，不会挂。
- 灰度是对解码后的像素做 BT.709 亮度转换，和 sharp 的 `grayscale` 观感一致。
- 输出质量会在「像素数 × 原图体积」都很大时按原项目策略自动打折（最低到设定值的 10%）。

## 目录

```
src/index.js      Worker 入口：取图 → 判断 → 解码/灰度/编码 → 响应 + 缓存
src/lib.js        纯函数：参数解析、格式嗅探、动图判断、质量调整、SSRF 防护
test/lib.test.mjs 单元测试（node --test）
wrangler.toml     部署配置
```

跑测试：

```bash
npm test        # node --test test/lib.test.mjs
```

## 免责声明

和原项目一样，这**不是**匿名代理：它会带着你的 Cookie/Referer 去取图，源站能看到真实请求来源。公开部署时请自行加访问控制（如 `ALLOW_ORIGIN` 校验、Cloudflare Access、或简单的 token 参数），否则容易被人当成免费图片代理刷。
