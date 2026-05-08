# Dump Sniper V1

Solana 砸盘反弹狙击机器人。监听指定代币的 Pump.fun AMM 大额卖单，
满足触发条件时立即买入，止盈或超时后自动卖出。

## 策略

| 项目 | 默认值 |
|---|---|
| 监控代币 | 手动添加（dashboard / webhook） |
| 触发：单笔卖出 SOL | ≥ 10 SOL |
| 触发：单笔自身 priceImpact | ≥ 10%（跌幅） |
| 入场仓位 | 1 SOL |
| 止盈 | +8% |
| 主动止损 | 无（硬扛到时间上限） |
| 最大持仓时长 | 15 秒 |
| 滑点 | 买 15% / 卖 20% |
| 同代币冷却 | 60 秒 |
| 全局并发持仓 | 最多 3 |
| 执行路径 | Pump.fun AMM 直接指令 |
| 数据源 | Helius LaserStream gRPC（processed） |
| 提交 RPC | Helius staked endpoint |

## 持久化和恢复

所有重要状态都保存在 SQLite (`data/sniper.db`)：

| 表 | 内容 | 重启后表现 |
|---|---|---|
| `tokens` | 监控代币列表（含 symbol/FDV/LP/pool 信息） | ✅ 自动加载 |
| `signals` | 检测到的所有信号（接受/拒绝） | ✅ 永久保留 |
| `trades` | 每笔买卖交易记录 | ✅ 永久保留 |
| `positions` | 持仓（含未平仓的） | ✅ **未平仓持仓启动时自动恢复**，超时立即触发 SELL |

启动恢复流程：
```
启动 → 读取 positions WHERE closed_at IS NULL
     → 重新加入内存 Map
     → PositionManager 100ms tick 检查超时
     → 已超 15s 的立即触发 SELL
     → 未超时的等价格更新或继续 tick
```

如果重启时正好有未关闭的持仓（比如崩溃前刚买入），程序起来后会**立即看到这笔持仓**并按 15s 超时规则卖出。SELL 失败会按指数退避（500ms / 1.5s / 3s / 5s / 10s / 20s / 30s …）持续重试直到成功，确保不会"钱卡在代币里"。

SQLite 用 WAL 模式 + `synchronous = NORMAL`，保证：
- 进程异常终止后最多丢失最近一次写入（毫秒级）
- 重启后能正常 recover
- 多个连接（TokenRegistry + TradeLogger 共享）安全并发

## 部署（systemd）

### 一键安装

```bash
# 在项目根目录
sudo bash deploy/install.sh
# 或指定路径：
sudo bash deploy/install.sh /home/ubuntu/dump-sniper-v1
```

脚本会做：
1. 拷贝项目到 `/opt/dump-sniper-v1`
2. 安装 npm 依赖
3. 写入 systemd unit 到 `/etc/systemd/system/dump-sniper.service`
4. 配置 logrotate 到 `/etc/logrotate.d/dump-sniper`

### 启动

```bash
# 编辑配置（必填 Helius/Birdeye keys）
sudo -u ubuntu vim /opt/dump-sniper-v1/.env

# 启动
sudo systemctl start dump-sniper

# 开机自启
sudo systemctl enable dump-sniper

# 状态
sudo systemctl status dump-sniper

# 实时日志
sudo journalctl -u dump-sniper -f
# 或
tail -f /opt/dump-sniper-v1/logs/out.log
```

### 重启 / 停止

```bash
sudo systemctl restart dump-sniper   # 平滑重启，会触发 SIGTERM 优雅退出
sudo systemctl stop dump-sniper
```

### 配置变更生效

```bash
sudo -u ubuntu vim /opt/dump-sniper-v1/.env
sudo systemctl restart dump-sniper
```

### systemd 自动恢复

服务文件中：
- `Restart=always` 进程崩溃后自动重启
- `RestartSec=5` 5 秒后重启
- `StartLimitBurst=10` 60 秒内重启 10 次以上才放弃（避免无限崩溃）
- `TimeoutStopSec=15` 给 SQLite WAL flush 留时间

### 网络限制

如果你不想 dashboard 暴露给公网，编辑 `.env`：
```bash
BIND_HOST=127.0.0.1   # 只监听本地
DASHBOARD_TOKEN=自己生成一个长随机串
```

然后用 SSH 隧道访问：
```bash
ssh -L 3001:127.0.0.1:3001 user@your-server
# 浏览器打开 http://localhost:3001/?token=你的token
```

webhook 同理可加保护：
```bash
WEBHOOK_SECRET=你的密钥
```

```bash
curl -X POST http://server:3001/webhook/add-token \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: 你的密钥" \
  -d '{"network":"solana","address":"BWJ7zJauzatao4FsBnGdVsqdBi3k5NbgSY62noZApump","symbol":"Nana"}'
```

## 使用

### 添加代币

**Dashboard：** 在监控列表面板输入 CA 后点击「添加」。

**Webhook：**
```bash
curl -X POST http://服务器IP:3001/webhook/add-token \
  -H "Content-Type: application/json" \
  -d '{"network":"solana","address":"BWJ7zJauzatao4FsBnGdVsqdBi3k5NbgSY62noZApump","symbol":"Nana"}' | jq .
```

地址会做 base58 + 长度校验，错误会返回 400。

### 查看交易记录

Dashboard 实时显示：
- **持仓 / 平仓** 当前持仓和最近平仓的盈亏
- **信号** 所有检测到的卖单（含被拒绝的，附拒绝原因）
- **交易** 所有 BUY/SELL 交易尝试，含成功/失败 + 重试次数

### 每日报告

每天 BJT 08:00 自动生成昨日完整报告，存到 `./reports/YYYY-MM-DD.md`。
也可以在 Dashboard 点「立即生成昨日报告」手动触发。

## 架构

```
                     ┌──────────────────┐
                     │  Helius          │
                     │  LaserStream gRPC│
                     └────────┬─────────┘
                              │ tx (processed)
                              ▼
                     ┌──────────────────┐
                     │  TickStream      │ (重连+重建订阅)
                     └────────┬─────────┘
                              ▼
                     ┌──────────────────┐
                     │  DumpDetector    │── priceTick ──▶ PriceTracker
                     │  (内存 mintSet)  │                    │
                     └────────┬─────────┘                    │
                              │ dumpSignal                   ▼
                              ▼                     ┌──────────────────┐
                     ┌──────────────────┐           │ PositionManager  │
                     │  SignalEngine    │           │ + 启动恢复        │
                     │  (冷却/并发)      │           │ + SELL 重试       │
                     └────────┬─────────┘           └────┬─────────────┘
                              │ buyOrder                  │ sell
                              ▼                            ▼
                     ┌──────────────────────────────────────┐
                     │  Executor (Pump AMM direct ix)       │
                     │  + blockhash 后台预热                  │
                     │  + priorityFee 后台预热                │
                     │  → Helius staked sendTransaction     │
                     └──────────────────────────────────────┘

                           ▲ ▲ ▲ ▲
                           │ │ │ │
                  SQLite (WAL+Normal): tokens / signals / trades / positions
```

## 健康监控 / Bug 定位

每个核心模块都接入了 `HealthMonitor`，三类信号：心跳 / 计数器 / 最近错误。出问题时直接定位到**哪个模块的哪一步**，不用翻日志。

### CLI 工具

```bash
npm run health           # 彩色摘要
npm run health:json      # 完整 JSON
HEALTH_URL=http://server:3001 npm run health   # 远程
DASHBOARD_TOKEN=xxx npm run health             # 启用 token 时
```

退出码：`0`=OK / `1`=DEGRADED / `2`=连不上。可以加 cron 监控告警邮件。

### 输出示例

```
Dump Sniper Health Report
  Status: DEGRADED
  Uptime: 2h 15m
  Memory: 142 MB

── Heartbeats ──
  ✅ TickStream         OK         last beat: 1s ago [tx]
  ✅ DumpDetector       OK         last beat: 1s ago [parse]
  ✅ SignalEngine       OK         last beat: 14s ago [signal]
  ✅ Executor           OK         last beat: 30s ago [buy:BWJ7zJ]
  ✅ PositionManager    OK         last beat: 0s ago [tick]

── Module Counters ──
  [TickStream]
    txReceived                    14823
    reconnects                    2
  [Executor]
    buyAttempts                   8
    buySuccess                    7
    buyFail                       1
    sellAttempts                  6
    sellSuccess                   6
    blockhashRefreshOk            10125
  [PositionManager]
    opened                        7
    closed                        6
    winners                       3
    losers                        3
    exitsBy_TAKE_PROFIT           3
    exitsBy_TIMEOUT               3
    sellRetries                   1

── 🔔 Active Alerts ──
  [WARN] tickstream.no_traffic
    LaserStream 监控 5 个代币，但 60s+ 无 tx 收到
    fired 12s ago

── Recent Errors ──
  [Executor]
    ✗ Custom: Error processing Instruction 4: custom program error: 0x1
      8s ago
      context: {"side":"BUY","mint":"BWJ7zJa...","symbol":"Nana","sizeSol":1}
```

### Dashboard 健康面板

页面底部"🩺 健康监控"面板实时显示心跳卡片、模块计数器、最近错误。任何模块的告警触发时，**dashboard 顶部会立即弹红色 toast**（通过 WebSocket 推送）。

### HTTP API

```bash
curl http://server:3001/api/health         # 完整 JSON
curl http://server:3001/api/health/summary # 纯文本摘要
```

### 自动告警规则

| 触发条件 | 严重度 | 含义 |
|---|---|---|
| 模块心跳超过 staleMs 未上报 | error | 模块卡死 |
| 监控代币非空但 60s+ 无 tx | warn | LaserStream 可能掉线或订阅过滤错 |
| BUY 失败率 ≥ 60%（≥3 笔） | error | 链上拒绝率高，priorityFee 不够 / 滑点不够 / pool 信息错 |
| **SELL 失败率 ≥ 60%** | **critical** | **资金可能卡在代币里** |
| 持仓 > maxHoldMs+5s 还没退出 | critical | SELL 一直失败 / SELL 路径死锁 |
| DumpDetector 解析错误率 > 10% | warn | 交易格式变化或代码 bug |

### 各模块的关键计数器

每个模块出问题时看哪个计数器：

| 模块 | 计数器 | 异常含义 |
|---|---|---|
| `TickStream` | `txReceived` | 长期 0 → LaserStream 没工作 |
| | `reconnects` | 短期内 > 5 → 网络问题 |
| | `streamErrors` | 持续增长 → 凭证问题 |
| `DumpDetector` | `parseErrors` | 占总比 > 10% → 数据结构变了 |
| | `dumpSignals` | 长期 0 → 阈值过高或没合适标的 |
| `SignalEngine` | `rejectedCooldown` | 高 → 同代币反复触发，考虑加大冷却 |
| | `rejectedMaxConcurrent` | 高 → 持仓不退出，往下游查 |
| `Executor` | `buyFail` | 看 `lastErrors[Executor]` 看具体 RPC 错误 |
| | `sellFail` | **优先级最高**，资金安全 |
| | `blockhashRefreshFail` | RPC 不稳定，BUY 路径会用过期 blockhash |
| `PositionManager` | `sellRetries` | 单数高 → SELL 正在被退避重试 |
| | `winners` / `losers` | 看胜率 |
| `TokenRegistry` | `metaFetchFail` | Birdeye/Helius API 失败 |

## 调试

```bash
# 查看实时日志
tail -f /opt/dump-sniper-v1/logs/out.log


# 查看数据
sqlite3 /opt/dump-sniper-v1/data/sniper.db "SELECT * FROM signals ORDER BY ts DESC LIMIT 20;"
sqlite3 /opt/dump-sniper-v1/data/sniper.db "SELECT mint, symbol, opened_at, closed_at, pnl_pct, exit_reason FROM positions ORDER BY opened_at DESC LIMIT 20;"
sqlite3 /opt/dump-sniper-v1/data/sniper.db "SELECT * FROM positions WHERE closed_at IS NULL;"  # 未平仓
sqlite3 /opt/dump-sniper-v1/data/sniper.db "SELECT * FROM tokens WHERE is_active = 1;"

# 查看 SELL 失败重试情况
sqlite3 /opt/dump-sniper-v1/data/sniper.db "SELECT mint, sell_attempts, last_error FROM positions WHERE sell_attempts > 1;"
```

## ⚠️ 上线前必读

### 1. DRY_RUN 跑够久再上实盘

强烈建议 `DRY_RUN=true` 先跑至少 24~48 小时，观察：
- 信号触发频率是否符合预期
- 假设成交后的"模拟" PnL 分布是否盈利
- 池子地址解析是否成功

### 2. Pump AMM 指令需校验

`src/utils/pumpAmm.js` 中的指令布局基于公开 IDL。如果 Pump 程序升级，
账户顺序或 discriminator 可能变化。**实盘前对比一笔已知成功的 Solscan 交易
校验账户顺序**。

### 3. Pool 信息绑定

DumpDetector 当前不会自动从交易解析 pool address（占位实现）。建议添加代币时手动通过 Solscan 查到该代币的 Pump AMM pool 地址、base vault、quote vault，调用：

```javascript
const tokenRegistry = require('./src/data/TokenRegistry');
const r = new tokenRegistry();
r.setPoolInfo('mintAddress', {
  poolAddress: 'xxx',
  poolBaseVault: 'xxx',
  poolQuoteVault: 'xxx',
});
```

或写一次性脚本批量补全。

**没有 pool 信息 LIVE 买入会失败**（DRY_RUN 不影响）。

### 4. 钱包安全

- 私钥放 `.env`，`.env` 加入 `.gitignore`
- 钱包内只放够交易的 SOL（比如 5~10 SOL）
- 定期轮换钱包

### 5. 资金竞争

砸盘反弹策略已有大量 MEV bot 在做，特别是 Jito bundle 抢跑的。
你的优势：手动选币、轻量监控；劣势：延迟和打包优先级。**不要预期高胜率**。

## v1.1 修复清单

相比 v1.0 修复：

**🔴 致命**
- ✅ `positionId` 在 BUY trade / position / SELL trade 三处一致（修复日报数据无法配对）
- ✅ 重启后未平仓持仓自动恢复（`PositionManager.restoreFromDb`）
- ✅ SELL 失败按指数退避无限重试（防止"钱卡在代币里"）
- ✅ SELL 失败时 `pos.exiting` 不再永久卡死
- ✅ BUY 完成不立即关闭 WSOL ATA（防止残留 WSOL 被销毁）
- ✅ Blockhash + priorityFee 后台预热，BUY 路径无 RPC 等待
- ✅ TickStream 监控为空时不订阅；列表变化时重建 stream
- ✅ accountInclude/Required 修正：tx 必须涉及 Pump 程序 AND 至少一个监控代币

**🟡 性能**
- ✅ DumpDetector 用内存 Set 取代 SQLite 查询（每 tx 一次）
- ✅ 所有 SQL prepare 一次缓存复用
- ✅ sellAnalyzed 只记录"接近触发"的（>= 50% 阈值），避免写入风暴

**🟢 可靠性 & 安全**
- ✅ Mint 地址 base58 + PublicKey 校验
- ✅ Webhook 可选 secret 验证
- ✅ Dashboard 可选 token 验证
- ✅ BIND_HOST 配置（默认 0.0.0.0，可改 127.0.0.1）
- ✅ SIGTERM 优雅退出（systemd 兼容）
- ✅ uncaughtException / unhandledRejection 不退出（systemd 不会狂重启）
- ✅ positions 表加 `buy_signature` / `sell_signature` / `sell_attempts` / `last_error` 字段
- ✅ 老 DB 自动 migrate

## 模块说明

| 文件 | 作用 |
|---|---|
| `config.js` | 集中配置 |
| `core/TickStream.js` | LaserStream gRPC 订阅 |
| `core/DumpDetector.js` | 解析交易，识别砸盘 |
| `core/PriceTracker.js` | 维护实时价格 |
| `core/SignalEngine.js` | 信号过滤（冷却/并发） |
| `core/Executor.js` | 构造并提交 Pump AMM 交易（含预热） |
| `core/PositionManager.js` | 持仓追踪、止盈/超时退出、SELL 重试、启动恢复 |
| `data/TokenRegistry.js` | 代币列表持久化（含内存缓存） |
| `data/TradeLogger.js` | 信号/交易/持仓持久化 |
| `utils/pumpAmm.js` | Pump AMM 指令构造 |
| `utils/tokenMeta.js` | Helius DAS + Birdeye |
| `utils/priorityFee.js` | 动态 priority fee |
| `utils/bjt.js` | 北京时间工具 |
| `reports/DailyReport.js` | 每日报告生成 |
| `server/server.js` | Express + WS dashboard |
| `deploy/dump-sniper.service` | systemd unit |
| `deploy/install.sh` | 一键部署脚本 |
| `deploy/logrotate.conf` | 日志轮转 |

## 后续可能的增强

- [ ] 自动从交易解析 Pump AMM pool address（替换占位实现）
- [ ] 支持 Raydium / Meteora 池（Jupiter fallback）
- [ ] Jito bundle 集成（真正的同区块抢跑）
- [ ] 信号回测：用历史 LaserStream 数据评估策略
- [ ] 风控增强：单日最大亏损、连续亏损暂停
