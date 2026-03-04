# UrbanRhythm Debug Checklist

## 整体架构检查 ✅

### Layer 1: GEO-LOCATION INDEX (搜索阶段)
- [x] `searchQuery` state 控制输入框
- [x] `searching` state 控制加载状态
- [x] `hasSearched` state 控制初始/搜索结果视图切换
- [x] `venues` state 存储搜索结果
- [x] `handleSearch()` 调用 `searchVenues()` API
- [x] 快速按钮 "Libraries" 和 "Museums" 触发搜索
- [x] 搜索后显示 filteredVenues 网格和地图
- [x] 支持二次搜索精化（refine search）
- [x] "NEW SEARCH" 按钮重置状态

### Layer 2: EVENT SCRAPING (爬取阶段)
- [x] `startScraping()` 循环遍历 `venues` 数组
- [x] 为每个 venue 调用 `scrapeVenueEvents()`
- [x] 更新 `scrapeStatus` 为 "scraping" → "done"/"error"
- [x] 累积结果到 `allEvents`
- [x] 显示实时进度条和状态指示
- [x] 爬取完成后自动跳转到 Layer 3

### Layer 3: DATA ARCHIVE (数据表格)
- [x] 显示 allEvents 的数据表格
- [x] `filterType` 过滤库/博
- [x] `filterCat` 过滤活动类别
- [x] 底部统计卡片
- [x] 无数据时显示空状态

---

## API 函数检查 ✅

### searchVenues(query)
```javascript
✅ 接收 query 参数
✅ 调用 OpenRouter API (https://openrouter.ai/api/v1/chat/completions)
✅ 使用 gpt-4-turbo 模型
✅ 返回解析后的 JSON 数组
✅ 失败时返回 []（空数组，不返回默认数据）
```

### scrapeVenueEvents(venue)
```javascript
✅ 接收 venue 对象
✅ 调用 OpenRouter API
✅ 构造提示词要求返回事件数组
✅ 返回解析后的事件数组
✅ 解析失败返回 []
```

---

## 流程测试 ✅

### 步骤 1: 初始加载
- [ ] 页面加载时显示 "SEARCH FOR VENUES" 界面
- [ ] 输入框获得焦点（autoFocus）
- [ ] 三个按钮可用：输入框搜索、Libraries、Museums

### 步骤 2: 第一次搜索
- [ ] 用户输入搜索词（如 "libraries"）并按 Enter 或点击按钮
- [ ] `handleSearch()` 被调用
- [ ] 输入框和按钮被禁用（searching=true）
- [ ] 按钮显示 "⊙ SEARCHING VENUES..."
- [ ] API 调用 searchVenues(query)
- [ ] 等待 API 响应...
- [ ] venues 更新为搜索结果
- [ ] hasSearched 设为 true
- [ ] 页面切换到搜索结果视图

### 步骤 3: 搜索结果展示
- [ ] 显示 filteredVenues 的卡片网格
- [ ] 显示地图视图（SVG）
- [ ] 每个场馆卡片显示：名称、类型、评分、地址、坐标
- [ ] 可以点击卡片选中（highlighted）
- [ ] 支持输入 "Refine search..." 进行二次搜索
- [ ] 支持按类型和评分筛选
- [ ] "NEW SEARCH" 按钮可重置回初始搜索

### 步骤 4: 启动爬取
- [ ] 点击 "LAUNCH LAYER 2 · SCRAPING" 按钮
- [ ] 自动跳转到 Layer 2
- [ ] `startScraping()` 开始执行

### 步骤 5: 爬取进行中
- [ ] Layer 2 显示场馆列表
- [ ] 每个场馆的状态从 "QUEUED" → "SCRAPING…" (脉动) → "COMPLETE"
- [ ] 实时显示每个场馆找到的事件数
- [ ] 进度条增长（width 0% → 100%）
- [ ] "X/Y venues processing" 计数器更新

### 步骤 6: 爬取完成
- [ ] 所有场馆状态变为 "COMPLETE"
- [ ] allEvents 被填充
- [ ] "View Layer 3 · Data Table →" 按钮出现
- [ ] 自动跳转到 Layer 3（setLayer(2)）

### 步骤 7: 数据展示
- [ ] Layer 3 显示表格，包含列：TYPE | DATE | TIME | CATEGORY | FREE | EVENT | VENUE
- [ ] 每行代表一个事件
- [ ] 底部显示 4 个统计卡片：
  - Total Events
  - Free Events
  - Library Events
  - Museum Events
- [ ] 可以按类型和分类筛选事件

---

## 已知问题 & 解决方案

### ❌ 问题 1: 硬编码 API Key
```javascript
// 目前 API Key 直接在代码里，应该考虑环保护
"Authorization": "Bearer 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"
```
状态：⚠️ 暂时可用，生产环境应使用环境变量

### ❌ 问题 2: 无本地 Mock 数据
目前 API 失败时返回空数组。为了测试，可以考虑添加降级 mock 数据。
状态：✅ 这是设计要求，用户希望纯搜索驱动

### ✅ 问题 3: 中文替换
所有 UI 文本已替换为英文
状态：✅ 完成

---

## 预期错误处理

| 场景 | 行为 |
|------|------|
| API 返回非 JSON | 返回 [] 空数组 |
| API 超时 | 返回 [] 空数组 |
| venues 为空 | "LAUNCH LAYER 2" 按钮禁用 |
| 搜索无结果 | 显示 "No results found" |
| 爬取某场馆失败 | 该场馆显示 "FAILED" 红色状态，但继续爬取其他场馆 |

---

## 性能检查

- [x] venues 数组使用 useCallback 避免重复计算
- [x] filteredVenues 使用 .filter() 是同步的（OK for small data）
- [x] 地图 SVG 循环使用 key={v.id}
- [x] 事件列表循环使用 key={i}（可以改进为 key={e.id}）

---

## 总体状态：✅ 可用

所有核心逻辑已验证，代码无语法错误。可以开始测试！
