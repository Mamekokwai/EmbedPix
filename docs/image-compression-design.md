# EmbedPix 图片压缩功能设计文档

> 文档状态：方案设计
>
> 适用版本：EmbedPix 0.8+ 规划
>
> 目标：在保持本地处理、嵌入式资源导出和安全覆盖策略的基础上，增加一个可解释、可批处理、可回滚的图片压缩工作台。

## 1. 背景与目标

EmbedPix 当前已经具备图片导入、尺寸调整、格式转换、像素格式导出、批处理、覆盖保护和 GIF 制作能力。下一步增加压缩功能时，不能简单地增加一个“质量”滑块，因为不同图片格式的压缩含义不同：

- JPEG/WebP 的质量参数主要控制有损编码的视觉质量与文件体积。
- PNG 的常规压缩是无损的，质量不会改变像素外观；要进一步显著减小体积，通常需要颜色量化、透明度处理或改用其他格式。
- BMP、RGB565 BIN、C 数组并不是典型的“文件体积压缩”目标，应该继续归入格式转换或嵌入式资源优化，而不是伪装成通用图片压缩。
- 元数据、ICC 色彩配置、EXIF/GPS 信息有隐私和色彩一致性影响，必须作为明确的独立策略。

本功能的产品目标：

1. 让用户能在一个本地工作台中批量压缩 PNG、JPEG、WebP 等常见图片。
2. 让用户能明确选择“无损”“有损”“目标体积”“输出格式”而不是猜测质量数字。
3. 在压缩前展示预计结果，在压缩后展示前后体积、比例和质量策略。
4. 复用现有导入、队列、输出位置、覆盖、`bak` 备份、删除源文件和失败回滚能力。
5. 默认不上传图片，不引入账号、云端 API 或后台统计。
6. 对每一张图片给出可理解的跳过原因，例如“压缩后更大”“目标格式不支持透明度”“源文件已是最优结果”。

非目标：

- 第一阶段不做云端压缩、账号、在线素材库和自动同步。
- 第一阶段不承诺对所有格式提供同等的有损能力。
- 不把 PNG、JPEG、WebP 的质量数字强行解释成同一种视觉质量。
- 不默认删除源文件或覆盖源文件。
- 不把 GIF/APNG 动画压缩和静态图片压缩混成一条不可解释的流程；动画压缩单独作为后续能力扩展。

## 2. 网络调研结论

### 2.1 Squoosh

Squoosh 是本地浏览器图片压缩工具，强调图片不发送到服务器，并提供多种编码器和即时对比。它的主要启发是：

- 压缩前后对比必须直接可见。
- 编码器选择应根据输出格式分组，而不是把所有参数堆在一个表单里。
- 本地处理是 EmbedPix 的差异化方向。
- 高级参数应按编码器动态显示。

来源：[GoogleChromeLabs/Squoosh README](https://github.com/GoogleChromeLabs/squoosh/blob/dev/README.md)

### 2.2 Caesium Image Compressor

Caesium 支持 JPG、PNG、WebP、TIFF，并将质量和可选尺寸调整放在同一个批处理工作流中。其发布记录还包含最大单图体积限制、按宽度或高度缩放和压缩后动作等典型需求。

对 EmbedPix 的启发：

- 批量列表必须有逐项状态，而不是只有一个全局进度条。
- 目标尺寸、质量和输出动作应该在同一个导出流程中完成。
- 大文件限制、损坏图片保护和导出后动作应该形成稳定契约。

来源：[Lymphatus/caesium-image-compressor](https://github.com/Lymphatus/caesium-image-compressor)

### 2.3 ImageOptim

ImageOptim 的典型流程是拖入图片后自动尝试多个优化器并保留更小的结果，同时将元数据删除、保留和备份原文件作为偏好选项。其文档特别强调 EXIF、GPS、色彩配置和作者信息可能影响隐私与显示结果。

对 EmbedPix 的启发：

- “自动择优”比让用户理解几十个编码器参数更适合作为默认入口。
- 元数据策略必须显式，尤其不能悄悄删除 ICC 色彩配置。
- 原文件备份和替换应该是可追踪、可回滚的文件操作。

来源：[ImageOptim 使用说明](https://imageoptim.com/howto.html)、[ImageOptim Preferences](https://imageoptim.com/help/prefs.html)

### 2.4 OxiPNG

OxiPNG 是 Rust 编写的多线程 PNG/APNG 无损优化器，提供优化级别、元数据剥离和透明像素优化等选项，采用 MIT 许可证。它适合 EmbedPix 的 Rust/Tauri 本地架构。

关键结论：

- PNG 无损压缩应优先使用 OxiPNG 类策略。
- `strip safe` 和 `strip all` 必须分开，而不是只有一个“清理元数据”。
- `alpha` 优化可能改变完全透明像素的 RGB 值，应在高级说明中标记为技术上的有损变换。
- 高优化级别有收益递减，不能把“最高级别”默认等同于“最优”。

来源：[oxipng/oxipng](https://github.com/oxipng/oxipng)

### 2.5 pngquant

pngquant 通过颜色量化把真彩 PNG 转为更高效的带 Alpha 的 8 位 PNG，支持质量区间、抖动强度、速度和“压缩后更大则跳过”。它通常能显著减小 PNG，但其官方仓库声明为 GPLv3 或商业许可双许可。

结论：

- 算法上适合 PNG 有损压缩。
- 许可证不能在未完成合规审查前直接捆绑进 EmbedPix 的默认发行包。
- 第一阶段应先提供 OxiPNG 无损；PNG 有损量化作为独立可选模块，待许可证或替代实现明确后再启用。

来源：[pngquant 官方 README](https://github.com/kornelski/pngquant/blob/main/README.md)

### 2.6 MozJPEG

MozJPEG 兼容 JPEG 标准，支持优化熵编码、渐进式 JPEG、trellis quantization 和质量控制，目标是在相近视觉质量下得到更小的 JPEG。

对 EmbedPix 的建议：

- JPEG 压缩需要质量、色度抽样、渐进式和熵编码优化几个独立概念。
- 质量 100 并不等于无损；过高质量通常导致体积显著增加而视觉收益很小。
- 初期可用现有 Rust `image` JPEG 编码器完成产品闭环，再将 MozJPEG 作为可选高质量后端。

来源：[Mozilla MozJPEG README](https://github.com/mozilla/mozjpeg/blob/master/README.md)、[MozJPEG usage](https://github.com/mozilla/mozjpeg/blob/master/usage.txt)

### 2.7 libwebp

libwebp 的 `cwebp` 工具同时支持有损、无损、Alpha 质量、压缩方法、目标体积、透明像素处理和不同图像预设。其质量值是 0–100，但不同于 JPEG 的质量含义。

对 EmbedPix 的建议：

- WebP 应提供“有损/无损”明确切换。
- `method` 应作为“编码耗时”而不是“画质”解释。
- Alpha 质量必须独立于颜色质量。
- WebP 目标体积可作为自动压缩候选搜索的后端。

来源：[libwebp WebP tools](https://github.com/webmproject/libwebp/blob/main/doc/tools.md)

### 2.8 libavif

libavif 提供 AVIF 编解码库和 `avifenc`/`avifdec` 工具，但需要选择 AV1 编码器依赖，例如 libaom、rav1e 或 SVT-AV1。它的能力强，但依赖体积、构建时间和发行测试成本明显高于 PNG/JPEG/WebP。

结论：AVIF 可以列入第二阶段，不应阻塞第一阶段的本地压缩闭环。

来源：[AOMediaCodec/libavif README](https://github.com/AOMediaCodec/libavif)

## 3. 产品定位

新增一个独立的“图片压缩”工作台，与现有“图片转换”和“GIF 制作”并列：

```text
图片转换：改变格式、尺寸、像素排列和嵌入式输出
图片压缩：在尽量保持视觉质量的前提下减少文件体积
GIF 制作：图片序列或视频生成动画
```

压缩工作台可以复用以下现有能力：

- 文件选择、拖放、多文件导入和文件夹导入。
- 统一任务队列、进度、暂停、取消、失败详情和重试。
- 源文件夹、子文件夹、自定义目录、原位覆盖、`bak` 备份和删除源文件。
- 工作区保存/打开和参数预设。
- 本地 Tauri 命令、资源限制和原子写入。

## 4. 功能分期

### Phase 1：可靠的静态图片压缩闭环

必须交付：

- PNG 无损优化。
- JPEG 有损重编码。
- WebP 有损和无损输出。
- 原格式输出和显式改格式输出。
- 质量预设：高质量、平衡、小体积、自定义。
- 元数据策略：保留、清理安全元数据、全部清理。
- 体积预估和压缩前后统计。
- 批量处理、逐项状态、跳过更大结果。
- 输出位置、覆盖、备份、删除源文件和失败回滚。
- 本地调试日志和 CLI 可验证输出。

### Phase 2：智能择优与高级参数

- 自动尝试多个候选参数，选择最小且满足质量/体积约束的结果。
- JPEG 渐进式、色度抽样、MozJPEG 后端。
- PNG 颜色量化后端，待许可证或替代实现确认。
- WebP Alpha 质量、编码 method、near-lossless。
- 目标文件体积和最大文件体积。
- 质量指标：SSIM、PSNR，作为参考而不是唯一决策。
- “压缩后更大则保留原文件”。
- 常用参数预设和最近使用配置。

### Phase 3：扩展格式与动画

- AVIF：libavif + 明确的 AV1 编码器依赖。
- JPEG XL：仅在生态、依赖和发行体积重新评估后加入。
- GIF/APNG/WebP 动画压缩。
- 逐帧去重、帧间优化、颜色表优化。
- 动图专用体积目标和时长保持策略。

## 5. 算法和后端设计

### 5.1 抽象接口

Rust 侧新增独立压缩域模块，不把压缩参数继续塞入现有 `ExportImageRequest`：

```rust
pub enum CompressionFormat {
    Png,
    Jpeg,
    Webp,
    Avif,
}

pub enum CompressionMode {
    Lossless,
    Lossy,
    Auto,
}

pub enum CompressionEngine {
    OxiPng,
    ImageJpeg,
    MozJpeg,
    LibWebp,
    LibAvif,
    Auto,
}

pub struct CompressImageRequest {
    pub input_path: String,
    pub output_path: String,
    pub format: CompressionFormat,
    pub mode: CompressionMode,
    pub engine: CompressionEngine,
    pub quality: Option<u8>,
    pub effort: Option<u8>,
    pub target_bytes: Option<u64>,
    pub max_bytes: Option<u64>,
    pub keep_metadata: bool,
    pub strip_safe_metadata: bool,
    pub preserve_alpha: bool,
    pub skip_if_larger: bool,
}

pub struct CompressImageResponse {
    pub output_path: String,
    pub input_bytes: u64,
    pub output_bytes: u64,
    pub saved_bytes: i64,
    pub saved_ratio: f64,
    pub format: String,
    pub engine: String,
    pub quality: Option<u8>,
    pub metadata_action: String,
    pub skipped: bool,
}
```

实际字段名可以按现有 Rust 代码风格调整，但必须保证：请求参数、预检结果、进度事件、最终结果使用同一套语义。

### 5.2 后端矩阵

| 输入 | 默认输出 | 无损策略 | 有损策略 | 第一阶段 |
|---|---|---|---|---|
| PNG | PNG | OxiPNG 重滤波/重压缩 | 暂不默认启用颜色量化 | 必须 |
| JPEG | JPEG | JPEG 不支持无损压缩，统一按质量重编码 | Image JPEG；透明输入先按显式 `#RRGGBB` 背景（默认白色）合成，后续 MozJPEG | 必须 |
| WebP | WebP | WebP lossless；已支持 80/90/95 近无损等级 | libwebp；有损质量 1–100、method 0–6 | 必须 |
| BMP | PNG/WebP/JPEG | 重新编码到无损 PNG/WebP | 按用户选择输出 JPEG/WebP | 支持转换，不做 BMP 原位压缩 |
| TIFF | TIFF/PNG/WebP | TIFF 无损重写或转换 | WebP/JPEG | 第二阶段 |
| GIF 静态 | PNG/WebP | 解码首帧后无损输出 | 用户明确选择后有损输出 | 第一阶段可选 |
| GIF/APNG/WebP 动画 | 原格式 | 逐帧优化 | 逐帧量化/降帧 | 第三阶段 |

### 5.3 推荐预设

#### 高质量

- JPEG：质量 90，优化熵编码，保守色度抽样。
- WebP：质量 88，method 4，保留 Alpha。
- PNG：OxiPNG 优化级别 3，`strip safe`，启用安全 Alpha 优化。
- 不主动降尺寸。
- 目标：肉眼接近原图，体积适度下降。

#### 平衡

- JPEG：质量 82，优化熵编码。
- WebP：质量 80，method 4。
- PNG：OxiPNG 优化级别 4，`strip safe`。
- 可选按最长边限制尺寸。
- 目标：默认推荐，体积和质量平衡。

#### 小体积

- JPEG：质量 72，允许更激进的色度抽样。
- WebP：质量 70，method 5。
- PNG：无损优化；如果用户启用 PNG 有损量化，必须显式标注“有损”。
- 默认建议移除 EXIF/GPS，保留 ICC 直到用户选择全部清理。
- 目标：网页、缩略图、预览图。

#### 嵌入式资源

- 不以文件体积为唯一目标。
- 优先保留尺寸、Alpha、色彩语义和目标像素格式。
- 继续使用图片转换工作台输出 RGB565 BIN、C 数组、BMP 等。
- 压缩工作台只提供“生成 PNG/WebP 资源”作为附加选项，避免破坏 MCU 端预期。

## 6. 质量、体积和自动压缩策略

### 6.1 参数优先级

用户设置按以下优先级生效：

1. 安全限制：最大输入字节、最大像素、最大输出字节、最大内存。
2. 输出格式与透明度约束。
3. 用户明确的目标体积或最大体积。
4. 用户选择的质量/努力等级。
5. 预设默认值。

### 6.2 目标体积搜索

目标体积不能简单通过一次编码得到，应使用有边界的候选搜索：

```text
输入图像
  ↓
读取尺寸、透明度、元数据和原始体积
  ↓
根据格式生成候选参数
  ↓
编码候选文件到临时目录
  ↓
检查体积、解码有效性、像素尺寸和 Alpha
  ↓
未达到目标：降低质量 / 增加 effort / 降低尺寸
  ↓
达到目标：选择质量最高的候选
  ↓
仍无候选：报告“目标不可达”，不发布输出
```

推荐候选顺序：

1. 保持原尺寸，调整质量。
2. 保持质量，逐步降低最长边。
3. 保持 Alpha，尝试更高编码 effort。
4. 只有用户启用时才降低颜色数、移除 Alpha 或更换格式。

### 6.3 体积判断

- 默认 `skip_if_larger = true`。
- 输出比输入大时不替换原文件，并标记为“已跳过：压缩后更大”。
- 目标体积模式允许输出略高于目标的结果，但必须显示超出比例。
- 若没有任何候选达到最大体积，不产生正式输出。
- 预估结果只能显示“估算”，最终以临时文件实际字节数为准。

### 6.4 质量指标

第一阶段只把质量、文件大小和缩放结果作为主要信息；第二阶段可以加入 SSIM/PSNR：

- SSIM 更接近结构相似度，但不能代表所有图片的主观质量。
- PSNR 适合比较编码差异，但不应单独决定最终候选。
- 透明边缘、文字、像素画和嵌入式图标需要专门的视觉检查。

## 7. 元数据和隐私策略

压缩页面单独提供“元数据”模块：

### 保留全部

- 保留 EXIF、ICC、XMP、IPTC 等可安全复制的元数据。
- 可能导致文件更大。
- 适合摄影、色彩管理和归档。

### 清理安全元数据（默认推荐）

- 删除不会影响渲染的冗余块和注释。
- 对 ICC、方向信息和必要解码参数进行保守处理。
- JPEG 的 EXIF Orientation 必须先应用到像素，再决定是否移除标签。

### 全部清理

- 删除 GPS、设备型号、拍摄时间、作者、软件信息和非必要色彩元数据。
- 需要明确警告：“可能改变颜色显示或丢失版权/作者信息”。

### 必须保留的安全原则

- 不在日志中写入图片内容、EXIF 全量内容或完整本地路径以外的敏感信息。
- 默认不上传图片。
- 失败日志只记录错误类型、阶段、字节数和可脱敏的文件名。
- 若用户选择删除源文件，压缩成功后才执行，并沿用现有回滚机制。

## 8. UI 设计

### 8.1 页面结构

采用与现有图片转换/GIF 页面一致的模块化卡片：

```text
图片压缩
├─ 01 / SOURCE       源图片
│  ├─ 拖放或选择图片
│  ├─ 导入文件夹
│  └─ 已导入列表：缩略图 / 原体积 / 尺寸 / 格式 / 状态
├─ 02 / PREVIEW      压缩预览
│  ├─ 原图 / 压缩图切换
│  ├─ 透明棋盘格
│  ├─ 原体积 / 预计体积 / 节省比例
│  └─ 当前图片质量提示
├─ 03 / COMPRESSION  压缩设置
│  ├─ 压缩模式：智能 / 无损 / 有损
│  ├─ 输出格式：保持原格式 / PNG / JPEG / WebP
│  ├─ 预设：高质量 / 平衡 / 小体积 / 自定义
│  ├─ 质量、努力等级、目标体积
│  ├─ Alpha 与元数据
│  └─ 高级编码参数
├─ 04 / OUTPUT       输出设置
│  ├─ 源文件夹 / 子文件夹 / 指定目录
│  ├─ 新文件名规则
│  ├─ 跳过更大结果
│  ├─ 覆盖同名文件
│  ├─ 覆盖原图并备份到 bak
│  └─ 删除源文件（单独确认）
└─ 任务状态
   ├─ 预检
   ├─ 处理中
   ├─ 已完成 / 部分完成
   ├─ 已取消
   └─ 失败详情 / 重试失败项
```

### 8.2 交互原则

- 没有导入文件时，压缩按钮禁用并显示下一步提示。
- 只有选中图片后才显示与该格式相关的参数。
- 选择“保持原格式”时，PNG/JPEG/WebP 分别显示不同的参数说明。
- “目标体积”开启后，质量滑块变成搜索边界，并显示“自动尝试候选参数”。
- 压缩过程中禁用导入、移除、排序、参数修改和输出位置修改。
- 取消只停止当前任务，不删除已完成且已发布的结果。
- 失败后显示“重试失败项”和具体原因，不能只显示一个通用错误。
- 结果列表支持“打开文件夹”“复制路径”“重新压缩”。

### 8.3 预览信息

每个文件至少显示：

```text
原图：photo.png · 4.8 MB · 3840 × 2160 · PNG · RGBA
结果：photo.png · 1.7 MB · 节省 64.6%
模式：OxiPNG 无损 · 元数据：清理安全项
状态：已完成
```

如果结果不适合替换：

```text
已跳过：压缩后为 5.1 MB，比原文件大 6.2%
```

## 9. 文件和输出安全

压缩功能必须复用现有 `ExportSafetyPlan` 思路，不重新实现一套危险的文件操作。

### 默认行为

- 默认输出到源文件夹的 `compressed` 子目录，或使用用户在设置中的默认策略。
- 默认不覆盖、不删除源文件。
- 默认不创建 `bak`，只有用户选择覆盖原图时才创建。
- 默认开启“压缩后更大则跳过”。

### 覆盖同名文件

- 先写唯一临时文件。
- 校验文件可以解码、格式正确、体积在限制内。
- 使用原子替换。
- Windows 替换失败时保留旧文件和临时文件清理保护。

### 覆盖原图

- 原图先移动到同目录 `bak` 文件夹。
- 临时文件发布为原路径。
- 新文件发布失败时恢复原图。
- 备份文件名必须避免冲突并保留扩展名。

### 删除源文件

- 必须二次确认。
- 只有对应输出成功并完成校验后才删除源文件。
- 批量任务中，成功项可以删除，失败项必须保留。
- 删除失败时不得删除新输出，错误详情要指出具体路径。

## 10. 前端/桌面接口

建议新增：

```text
compress_image
preflight_image_compressions
get_image_compression_progress
cancel_image_compression
estimate_image_compression
```

接口约束：

- 所有命令接收显式 `jobId`。
- 进度包含 `index`、`total`、`inputBytes`、`outputBytes`、`savedBytes`、`phase`。
- 取消必须可重复调用且幂等。
- 取消后临时文件和临时目录必须清理。
- 失败结果必须包含 `stage`、`code`、`message`，前端负责展示可读文本。
- 预估命令不得写入正式输出目录。
- 正式发布前必须做解码校验。

### 建议的阶段枚举

```text
queued
reading
decoding
planning
encoding
validating
publishing
completed
skipped
cancelled
failed
```

### 错误码

```text
unsupported_format
invalid_parameters
decode_failed
encode_failed
metadata_failed
target_unreachable
target_exists
output_larger
target_size_unreachable
insufficient_disk_space
cancelled
publish_failed
rollback_failed
```

## 11. 性能和资源限制

压缩比越高，内存峰值越可能高于原文件体积，因此沿用现有资源限制并单独记录：

- 最大输入文件字节数。
- 最大像素数和最大边长。
- 最大同时编码任务数，默认 1–2 个。
- 单任务最大临时空间估算。
- 最大候选搜索次数由用户选择 1–12 次，默认 8；后端强制执行同范围上限。
- 单文件最大处理时间，超时可取消。
- 批量总任务取消时，正在编码的任务需尽快停止，已发布结果保持一致。

建议策略：

- 小图和少量任务可直接并行。
- 大图、目标体积搜索和 AVIF 使用串行或低并发。
- 预览只编码当前选中图片，不提前编码全部列表。
- 临时文件采用应用缓存目录，并在启动时清理过期目录；GIF spool 为每个帧目录创建旁路独占锁，清理前必须成功取得锁，避免误删其他实例正在使用的帧目录。

## 12. 测试计划

### 12.1 算法测试

- PNG 无损输出像素逐点一致。
- JPEG 输出可以解码，尺寸一致，质量参数边界有效；透明输入按指定背景合成，不能静默丢弃 Alpha。
- WebP 有损/无损输出可以解码，Alpha 保留策略有效。
- 透明 PNG 的完全透明像素处理符合策略。
- 元数据保留、清理安全项、全部清理分别可验证。
- 压缩后更大时不发布正式结果。
- 目标体积不可达时不产生半成品。
- 目标体积搜索结果满足最大体积限制。

### 12.2 文件安全测试

- 非覆盖模式不修改源文件。
- 覆盖同名成功时旧文件不残留为损坏内容。
- 覆盖原图先备份到 `bak`。
- 写入失败恢复原图。
- 删除源失败时新输出和旧文件均可恢复。
- 同名并发任务只有一个成功发布。
- 目标路径、子目录和文件名拒绝路径穿越及 Windows 保留名。
- 取消时临时文件、临时目录清理。

### 12.3 UI 测试

- 未导入图片时压缩按钮不可用。
- 导出中导入、删除、排序、修改参数均被阻止。
- 取消后可以重新开始新的压缩任务。
- 部分失败只重试失败项。
- 结果列表显示原体积、结果体积和节省比例。
- 切换页面后任务状态和 Blob URL 正确清理。
- 最小窗口、窄窗口和窄高窗口不卡片重叠，不出现无意义横向滚动条。
- 键盘可用：Tab、Enter、Space、Escape。

### 12.4 样本集

至少准备：

- 大尺寸摄影 JPEG。
- 带 EXIF/GPS/ICC 的 JPEG。
- 透明 PNG、半透明 PNG、像素画 PNG。
- 调色板 PNG。
- 已压缩 WebP、有损 WebP、无损 WebP。
- BMP、TIFF、ICO。
- 损坏文件、扩展名与真实格式不一致的文件。
- 0 字节文件、超大文件、超过像素限制的文件。
- 200 张混合格式批量图片。

## 13. 许可证和发布策略

### 推荐第一阶段依赖策略

1. 继续使用现有 `image` crate 完成 JPEG/WebP 基础编码闭环。
2. 引入 OxiPNG 前完成 Rust 依赖审查和许可证清单更新；OxiPNG 官方仓库标注 MIT。
3. MozJPEG 作为后续可选后端，记录其依赖链和许可证文本。
4. pngquant 暂不直接捆绑，除非确定 GPLv3 或商业许可符合 EmbedPix 的发行方式。
5. libavif 进入第二阶段，明确静态链接、AV1 编码器和 Windows 安装包体积影响。

每新增一个编码器必须：

- 固定版本而不是跟踪主分支。
- 记录许可证、版权和第三方声明。
- 为 x64/ARM64 分别构建和测试。
- 验证 Windows 安装包不弹出控制台窗口。
- 验证 updater 资产、签名和 SHA256 清单。

## 14. 配置与预设

建议新增压缩偏好：

```json
{
  "compressionPreset": "balanced",
  "compressionDefaultFormat": "keep",
  "compressionSkipIfLarger": true,
  "compressionMetadataPolicy": "strip-safe",
  "compressionPreserveAlpha": true,
  "compressionMaxInputBytes": 536870912,
  "compressionMaxOutputBytes": 268435456,
  "compressionDefaultOutputLocation": "subfolder",
  "compressionDefaultSubfolder": "compressed"
}
```

预设必须可导入/导出 JSON，并遵循现有设置版本迁移机制。导入未知字段时忽略，不因新增字段导致旧设置无法读取。

## 15. 分阶段实施任务

### M1：领域模型和预检

- [ ] 新增压缩请求/响应/进度类型。
- [ ] 新增格式、模式、后端和元数据策略枚举。
- [ ] 实现输出路径和安全预检。
- [ ] 实现目标体积和资源限制校验。
- [ ] 补纯逻辑测试。

### M2：PNG 无损

- [ ] 集成 OxiPNG 或等价 MIT 许可后端。
- [ ] 支持优化级别、透明像素策略和安全元数据清理。
- [ ] 实现临时文件、解码校验和原子发布。
- [ ] 补 PNG 像素一致性测试。

### M3：JPEG/WebP

- [ ] JPEG 质量、优化熵编码、渐进式开关。
- [ ] WebP 有损/无损、质量、Alpha 质量和 method。
- [ ] 统一预览结果和真实输出结果。
- [ ] 补边界质量和透明度测试。

### M4：压缩工作台 UI

- [ ] 新增侧栏入口和页面骨架。
- [ ] 复用图片转换导入卡片和输出模块。
- [ ] 实现对比预览、参数分组和逐项状态。
- [ ] 实现暂停、取消、失败重试和结果操作。
- [ ] 补布局和键盘契约测试。

### M5：批处理和安全覆盖

- [ ] 批量队列接入统一任务状态。
- [ ] 支持“压缩后更大则跳过”。
- [ ] 覆盖同名、原图备份、删除源和回滚。
- [ ] 预检磁盘空间和目标冲突。
- [ ] 补桌面 smoke。

### M6：自动择优

- [ ] 目标体积搜索。
- [ ] 质量/尺寸联合搜索。
- [ ] 候选结果解码和指标校验。
- [ ] 记录最终候选参数摘要。

### M7：高级后端

- [ ] 评估 MozJPEG 集成。
- [ ] 评估 PNG 有损量化的许可证或替代实现。
- [ ] 评估 AVIF 依赖、包体积和多平台发布。
- [ ] 评估动画压缩。

## 16. 第一版验收标准

第一版只有满足以下条件才允许发布：

1. PNG、JPEG、WebP 三类文件可以批量处理。
2. 用户能明确选择无损/有损和预设。
3. 所有正式输出均先写临时文件并验证可解码。
4. 压缩后更大时默认跳过，不覆盖源文件。
5. 覆盖原图失败时能恢复原文件。
6. 删除源文件有二次确认，并且只在对应输出成功后执行。
7. 取消、失败、重试和切页不会留下不可清理的临时文件。
8. 前端、Rust、桌面 smoke 和发布资产验证全部通过。
9. 许可证和第三方声明完成更新。
10. 文案清楚区分“质量”“体积”“元数据”“透明度”和“输出格式”。

## 17. 推荐的最终用户默认流程

```text
拖入图片
  ↓
自动读取格式、尺寸、体积、透明度和元数据
  ↓
默认选择“平衡 + 保持原格式 + 压缩后更大则跳过”
  ↓
显示预估体积和前后预览
  ↓
用户可切换无损/有损、质量、目标体积和元数据策略
  ↓
点击“开始压缩”
  ↓
预检冲突、磁盘空间、格式和资源限制
  ↓
逐项压缩并显示进度
  ↓
校验临时结果
  ↓
按输出策略安全发布
  ↓
显示每项节省体积、跳过原因和失败重试入口
```

## 18. 结论

EmbedPix 不应直接复制某一个压缩器的全部参数，而应将成熟项目的优点组合成适合本地嵌入式工具的工作流：

- 参考 Squoosh 的本地处理和对比预览。
- 参考 Caesium 的批处理、质量和尺寸控制。
- 参考 ImageOptim 的多后端择优、元数据策略和原文件保护。
- 采用 OxiPNG 作为第一阶段 PNG 无损优化方向。
- 采用现有 Rust 图片编码能力完成 JPEG/WebP 基础闭环，后续评估 MozJPEG/libwebp/libavif。
- 以安全预检、原子发布、失败回滚和可解释状态作为 EmbedPix 的核心差异。

第一阶段的重点不是“支持最多算法”，而是让用户在本地批量压缩时始终知道：用了什么算法、输出为什么变小、元数据是否被删除、结果是否真的可用，以及失败后原文件是否安全。
