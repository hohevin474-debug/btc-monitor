/**
 * 构建脚本：把 public/index.html 内嵌为 ES module
 *
 * 为什么不直接用 Cloudflare Pages？
 *   当前 API Token 缺 Pages 权限，Pages 步骤持续失败（code 10000），
 *   面板从未成功更新过。Worker 部署一直是成功的，所以让 Worker 自己
 *   托管面板 —— 零额外权限、零额外配额、与业务逻辑同版本原子发布。
 *
 * 用法：node build.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(__dirname, 'public', 'index.html');
const out = path.join(__dirname, 'src', 'dashboard.js');

const html = fs.readFileSync(src, 'utf8');

if (!html.includes('</html>')) {
  console.error('❌ public/index.html 内容异常，缺少 </html>');
  process.exit(1);
}

// JSON.stringify 负责转义引号/反斜杠/换行，避免手写模板字符串踩坑
const mod = `// 自动生成，请勿手改 —— 源文件 public/index.html，运行 node build.js 重新生成
export const DASHBOARD_HTML = ${JSON.stringify(html)};
`;

fs.writeFileSync(out, mod, 'utf8');

const kb = (Buffer.byteLength(mod, 'utf8') / 1024).toFixed(1);
console.log(`✅ 已生成 src/dashboard.js（${kb} KB，源自 public/index.html ${html.length} 字符）`);
