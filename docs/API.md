# API 0.1.0

统一前缀`/api/v1`。成功`{data,requestId}`；失败`{error:{code,message},requestId}`。401未登录，403无权限，404资源不存在，409状态/并发冲突，413请求过大，415媒体类型不支持，422字段校验，429登录频控，503未配置支付。JSON操作需`Content-Type: application/json`；分片为二进制PUT。Cookie为HttpOnly/SameSite=Strict，生产Secure；修改接口验证Origin/Fetch-Site。

| 域 | 方法与路径 | 请求或响应要点 | 权限 |
| --- | --- | --- | --- |
| 登录 | POST /auth/login | username/password；只返回ok，设置Cookie | 匿名，基础频控 |
| 退出/上下文 | POST /auth/logout；GET /me | me返回本人工作空间与角色 | 本人 |
| 开通账号 | POST /users | username/password（12–256位） | 平台管理员 |
| 平台清单 | GET /admin/users；GET /admin/audit | 不回密码；审计最新100条 | 平台管理员 |
| 供应商注册 | POST/GET /admin/suppliers | name/username→供应商主体ID | 平台管理员 |
| 创建企业 | POST /enterprises | name | 已登录用户 |
| 企业邀请 | POST /workspaces/:w/invitations | username/role，7日到期 | 本企业owner/admin |
| 我的邀请 | GET /invitations；POST /invitations/:id/accept | 本人显式接受 | 受邀人 |
| 成员管理 | GET /workspaces/:w/members；DELETE /workspaces/:w/members/:user | 即时撤权，保留历史/其他空间 | 本企业管理人员 |
| 客户档案 | POST/GET /workspaces/:w/customers | name/username→客户ID | owner/admin |
| 项目列表/创建 | GET/POST /workspaces/:w/projects | name/customerId；设计师仅看分配项目 | owner/admin/designer |
| 项目读写 | GET/PUT /projects/:id | PUT expectedVersion/scene | 项目管理员或分配设计师 |
| 转派 | POST /projects/:id/reassign | designerId须为有效成员 | owner/admin |
| 新修订 | POST /projects/:id/fork | expectedVersion；仅锁版后可用 | 项目编辑人员 |
| 场景清单 | GET /projects/:id/bom | 从SKU和供给计算，排除existing | 项目编辑人员，成本不返 |
| 资产清单 | GET /workspaces/:w/assets | SHA256/状态/大小，无任意文件URL | 有效成员 |
| 上传初始化 | POST /workspaces/:w/uploads | name.glb/size/sha256/parts；服务端ID | owner/admin/product_manager |
| 查询分片 | GET /uploads/:id | completedParts与hash | 上传者且仍有权限 |
| 写分片 | PUT /uploads/:id/parts/:n | n从0开始，每片4MiB，末片剩余字节 | 同上 |
| 完成上传 | POST /uploads/:id/complete | 全文件散列、GLB头和依赖检查 | 同上 |
| 原件 | GET /assets/:id/original | 每次鉴权、无永久公开URL、审计 | owner/admin/product_manager |
| 系列 | POST/GET /workspaces/:w/families | name→familyId | 写入需产品管理权限 |
| SKU | POST /workspaces/:w/variants | familyId/sku/name/width/depth/height/assetId可选；mm | 产品管理权限 |
| 供给 | POST /workspaces/:w/offers | variantId/supplierId/saleFen/costFen/stock/validUntil毫秒 | 产品管理权限 |
| 目录 | GET /workspaces/:w/catalog | 非管理/财务/产品岗不返回cost_fen | 有效成员 |
| 提交快照 | POST /projects/:id/submit | expectedVersion；客户须已关联 | 项目编辑人员 |
| 提交列表/详情 | GET /submissions；GET /submissions/:id | 公开场景/BOM，不返成本或供货商 | 指定客户或项目编辑人员 |
| 双确认/退回 | POST /submissions/:id/review | action=design/bom/changes，hash须匹配 | 指定客户 |
| 批注 | POST /submissions/:id/comments | body，2000字内 | 客户/项目授权人 |
| 终审 | POST /submissions/:id/finalize | 双确认+报价/供给有效性 | 项目编辑人员 |
| 双采购 | POST /submissions/:id/choice | choice=self/platform，重复同选择幂等 | 指定客户 |
| 清单导出 | GET /submissions/:id/export | 完成采购选择后下载CSV，公式注入转义 | 指定客户/项目授权人 |
| 销售单 | GET /orders | 冻结金额/订单行，成本不返 | 客户/项目编辑人员 |
| 采购单 | GET /purchases | 只显示本供应商的采购价 | 供应商绑定账号 |
| 采购流转 | POST /purchases/:id/status | status=accepted/shipped，顺序校验 | 本供应商 |
| 沙箱回调 | POST /payment-webhooks/sandbox | eventId/orderId/amountFen/currency；x-signature=原始请求体HMAC-SHA256十六进制 | Secret验签，默认关闭 |

金额一律整数分；validUntil使用Unix毫秒，场景尺寸mm、rotation弧度。客户端传价格/供应商文本不会影响BOM或订单。

采购choice、重复分片/完成上传、付款事件具有幂等处理。普通创建类端点尚未实现通用Idempotency-Key；列表未全面分页，UI只作小规模验收。生产前必须补齐全量Schema/OpenAPI、分页、通用幂等和详细字段权限。
