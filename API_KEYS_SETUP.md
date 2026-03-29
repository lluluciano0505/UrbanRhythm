# 🔐 API 密钥设置指南

## 安全做法

你的 `.env` 文件已被清空，所有 API 密钥都需要你手动添加。这样做是为了：

✅ **防止密钥泄露** - 即使仓库被公开，密钥也是安全的  
✅ **保护你的账户** - 恶意用户无法使用你的 API 密钥  
✅ **遵循最佳实践** - 生产环境标准配置  

## 如何设置

### 步骤 1: 复制模板
```bash
cp .env.example .env
```

### 步骤 2: 获取 Google Maps API Key

1. 访问 https://console.cloud.google.com
2. 创建新项目或选择现有项目
3. 启用 **Places API**
4. 创建 API Key (应用程序密钥)
5. 复制密钥到 `.env`:
   ```
   VITE_GOOGLE_MAPS_API_KEY=YOUR_KEY_HERE
   ```

### 步骤 3: 获取 OpenRouter API Key

1. 访问 https://openrouter.io
2. 注册或登录
3. 生成 API Key
4. 复制密钥到 `.env`:
   ```
   VITE_OPENROUTER_API_KEY=sk-or-v1-YOUR_KEY_HERE
   ```

### 步骤 4: Jina Reader (不需要密钥！)
✅ 完全免费，无需任何设置

## 验证设置

```bash
# 启动系统
npm run dev:all

# 测试诊断（如果一切正常）
curl http://localhost:3333/api/test | jq '.'

# 应该看到：
# "jina": { "status": "✅ working" }
# "openrouter": { "status": "✅ working" }
# "perplexity": { "status": "✅ working" }
```

## 安全检查清单

- [ ] `.env` 已添加到 `.gitignore`
- [ ] `git status` 不显示 `.env` 文件
- [ ] `.env` 只在本地机器上保存
- [ ] 生产服务器使用环境变量 (不是 `.env` 文件)
- [ ] 定期轮换 API 密钥

## 如果密钥被暴露

**立即采取行动**:

1. **Google Maps**: 
   - 访问 https://console.cloud.google.com
   - 删除旧密钥
   - 生成新密钥

2. **OpenRouter**:
   - 访问 https://openrouter.io/keys
   - 删除泄露的密钥
   - 生成新密钥

3. **更新本地 `.env`**

## 生产环境部署

不要在生产环境使用 `.env` 文件！改用：

### Vercel / Netlify
```
在部署平台的 Dashboard 中设置环境变量
```

### Docker / 自托管
```bash
# 使用系统环境变量
export VITE_GOOGLE_MAPS_API_KEY=...
export VITE_OPENROUTER_API_KEY=...
npm run server
```

### AWS / GCP / Azure
```bash
# 使用密钥管理服务
# - AWS Secrets Manager
# - GCP Secret Manager
# - Azure Key Vault
```

## 常见问题

**Q: 为什么 `.env` 是空的？**  
A: 为了安全起见。每个开发者都应该有自己的 API 密钥，不应该在版本控制中分享。

**Q: 我可以提交 `.env` 吗？**  
A: **绝对不行！** 这会暴露你的密钥给任何有权访问仓库的人。

**Q: 我的密钥被推送到 GitHub 了怎么办？**  
A: 
1. 立即删除 API 密钥（见上面的说明）
2. 运行 `git rm --cached .env` 
3. 提交删除操作
4. 密钥在 GitHub 历史中仍然可见，但已不可用

---

✅ 现在你的 API 密钥是安全的！🔒
