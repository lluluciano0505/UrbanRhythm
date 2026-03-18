# 🕷️ UrbanRhythm 使用示例

## 快速测试

### 1. 启动服务器
```bash
npm run server
# 或同时启动前后端：
npm run dev:all
```

### 2. 爬虫单个场地
```bash
# 费城最受欢迎的 3 个场地

# Fillmore Philadelphia (音乐厅)
curl -X POST http://localhost:3333/api/scrape-venue \
  -H "Content-Type: application/json" \
  -d '{
    "name": "The Fillmore Philadelphia",
    "website": "https://www.fillmorephilly.com/",
    "type": "concert_hall"
  }' | jq '.events | length'

# Kimmel Center (表演艺术中心)
curl -X POST http://localhost:3333/api/scrape-venue \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Kimmel Center",
    "website": "https://www.kimmelcenter.org/",
    "type": "performance_hall"
  }' | jq '.events | length'

# Free Library (图书馆)
curl -X POST http://localhost:3333/api/scrape-venue \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Free Library of Philadelphia",
    "website": "https://www.freelibrary.org/events",
    "type": "library"
  }' | jq '.events | length'
```

### 3. 查看详细事件
```bash
# 获取 Fillmore 的第一个事件详情
curl -s -X POST http://localhost:3333/api/scrape-venue \
  -H "Content-Type: application/json" \
  -d '{
    "name": "The Fillmore Philadelphia",
    "website": "https://www.fillmorephilly.com/",
    "type": "concert_hall"
  }' | jq '.events[0]'
```

### 4. 批量爬虫
```bash
# 一次爬 3 个场地
curl -X POST http://localhost:3333/api/scrape-batch \
  -H "Content-Type: application/json" \
  -d '{
    "venues": [
      {
        "name": "The Fillmore Philadelphia",
        "website": "https://www.fillmorephilly.com/",
        "type": "concert_hall"
      },
      {
        "name": "Kimmel Center",
        "website": "https://www.kimmelcenter.org/",
        "type": "performance_hall"
      },
      {
        "name": "Union Transfer",
        "website": "https://www.utphilly.com/",
        "type": "music_venue"
      }
    ]
  }' | jq '.totalEvents'
```

### 5. 系统诊断
```bash
# 检查所有三层都在工作
curl -s http://localhost:3333/api/test | jq '.'

# 输出应该显示：
# jina: ✅ working
# openrouter: ✅ working
# perplexity: ✅ working
# pipeline: ✅ working
```

## 预期输出示例

### Fillmore Philadelphia
```json
{
  "events": [
    {
      "title": "Westerman",
      "date": "2026-03-20",
      "time": "TBD",
      "category": "Music",
      "description": "Westerman performing at The Fillmore Philadelphia with The Foundry and Skaiwater.",
      "free": false,
      "venue": "The Fillmore Philadelphia",
      "url": "https://www.fillmorephilly.com/",
      "event_url": "https://www.thefillmorephilly.com"
    },
    {
      "title": "Boys Go To Jupiter - Now You're A Circle Tour",
      "date": "2026-04-11",
      "time": "TBD",
      "category": "Music",
      "description": "Boys Go To Jupiter on their Now You're A Circle Tour at The Foundry.",
      "free": false,
      "venue": "The Fillmore Philadelphia",
      "url": "https://www.fillmorephilly.com/",
      "event_url": "..."
    }
  ],
  "strategy": "perplexity-search",
  "notes": "Via live web search"
}
```

## 常见场地列表

### 音乐场地
- **The Fillmore Philadelphia** - https://www.fillmorephilly.com/
- **Union Transfer** - https://www.utphilly.com/
- **World Cafe Live** - https://www.worldcafelive.com/
- **Underground Arts** - https://www.underground-arts.com/

### 表演艺术
- **Kimmel Center** - https://www.kimmelcenter.org/
- **Arden Theatre** - https://www.ardentheatre.org/
- **Walnut Street Theatre** - https://www.walnutstreettheatre.org/

### 美术馆
- **Philadelphia Museum of Art** - https://www.philamuseum.org/
- **Barnes Foundation** - https://www.barnesfoundation.org/

### 图书馆
- **Free Library of Philadelphia** - https://www.freelibrary.org/events

## 成本计算

```bash
# 查看不同规模的成本估计
node cost-calculator.js small        # 100 venues/month → $0.72/月
node cost-calculator.js medium       # 500 venues/month → $3.62/月
node cost-calculator.js large        # 1000 venues/month → $10.12/月
node cost-calculator.js enterprise   # 5000 venues/month → $50.62/月
```

## 响应字段说明

```javascript
{
  // 事件数组
  "events": [
    {
      "title": "string",           // 事件名称
      "date": "YYYY-MM-DD",        // ISO 日期格式
      "time": "HH:MM AM/PM",       // 时间，如果未知则 "TBD"
      "category": "Music|Theater|...",  // 事件类型
      "description": "string",     // 简短描述 (max 200 chars)
      "free": boolean,             // 是否免费
      "venue": "string",           // 场地名称
      "url": "https://...",        // 场地网址
      "event_url": "https://..."   // 事件详情页面链接
    }
  ],
  
  // 使用了哪一层管道
  "strategy": "jina-direct|jina-subpage|perplexity-search",
  
  // 补充说明
  "notes": "string"
}
```

## 故障排查

### 没有事件返回
```bash
# 1. 检查场地网址是否正确
curl -s "https://r.jina.ai/https://www.venue-website.com" | jq '.data.content' | head -20

# 2. 检查 API 诊断
curl -s http://localhost:3333/api/test | jq '.pipeline'

# 3. 检查是否真的没有事件（某些场地可能真的没有）
```

### API 超时
```bash
# 增加超时时间或减少批量大小
# 服务器默认已配置合理的超时和速率限制
```

### 成本太高
```bash
# 切回纯正则方案（0 成本，但精准度下降）
# 编辑 server.js，注释掉 Strategy C (Perplexity)
```

---

**Happy scraping! 🕷️✨**
