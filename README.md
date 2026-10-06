# Stable ExcaliDash compatibility fork

This fork adapts the upstream MCP server to the stable ExcaliDash 0.6.5
REST API. The upstream Agent API endpoints are absent from that release.
The container build overlays `compat/index.js` onto the compiled tool
registration module while retaining upstream HTTP transport and sessions.

Supported tools: `list_drawings`, `select_drawing`, `get_selected_drawing`,
`create_drawing`, `get_drawing`, `get_drawing_summary`,
`inspect_drawing_element`, and `update_drawing`.

`update_drawing` replaces complete elements with an explicit drawing version;
stale updates fail with 409. Omitted appState/files are preserved. The upstream
`apply_drawing_ops` tool is not exposed by this compatibility image. The stable
API needs Read drawings and Write drawings scopes, but no AI feature toggle.

Build and test the compatibility image:

```sh
docker build -t felinelogic/excalidash-mcp:<tag> .
```

The build runs upstream tests followed by the compatibility integration test.
Pushes to `main` and manual Actions runs publish a public Docker Hub image as
`felinelogic/excalidash-mcp:sha-<full-commit-sha>`. Publishing uses the repository
secret `DOCKERHUB_TOKEN`; its value is not committed. The workflow summary
records the digest for the Kubernetes deployment.
The deployment manifests and authenticated nginx gateway remain in
`ukashazia/cluster/apps/excalidraw`. This repository contains no deployment
credentials. The HTTP endpoint requires an authenticated gateway for public use.

## Per-client API key authentication

Set `MCP_AUTH_MODE=excalidash` for public HTTP deployments. Only
`EXCALIDASH_URL` is required; do not configure a shared `EXCALIDASH_API_KEY`.
Clients send their own `Authorization: Bearer exd_...` header on every request.
The server validates each key with ExcaliDash and creates a separate API client
for each MCP session. Sessions cannot be reused with another key. Revocation
is checked on each request, and ExcaliDash enforces the caller's account access
and read/write scopes for each tool.

ExcaliDash 0.6.5 has no API-key introspection route. The server probes its
read-only drawing-list route: a successful response or its exact authenticated
scope-denial response confirms an account key. Invalid/revoked keys return 401;
unavailable authentication fails closed with 503. Legacy drawing-scoped keys
are unsupported by that ExcaliDash release. The key probe has a five-second
timeout and no validation cache.

When connecting to the in-cluster frontend via HTTP, set
`EXCALIDASH_PROXY_PROTO=https` to preserve the externally terminated TLS
context and avoid backend HTTPS redirects. Use this only behind trusted internal
proxies.

The nginx gateway must preserve Authorization while forwarding to the
loopback adapter. It validates browser Origin and supplies localhost Host.
Without `MCP_AUTH_MODE=excalidash`, upstream private HTTP/stdio operation
retains its configured-key behavior; that mode must not be publicly exposed.

The documentation below describes the original upstream adapter; its Agent API
tools and AI feature requirements do not apply to the compatibility image.

---

# ExcaliDash MCP

셀프호스팅한 [ExcaliDash](https://github.com/ZimengXiong/ExcaliDash)의 드로잉을 MCP 클라이언트에서 조회하고 편집하는 서버입니다. ExcaliDash v0.6 계열의 Drawing Agent API를 얇게 감싸며 stdio와 Streamable HTTP를 지원합니다.
이 저장소는 ExcaliDash 공식 프로젝트가 아닌 독립 MCP 어댑터입니다.

## 지원 기능

- 드로잉 목록 조회와 이름 검색
- 작업할 드로잉 선택
- 빈 Excalidraw 드로잉 생성
- 구조 요약 조회
- 요소와 바인딩된 자식 요소 조회
- 최대 50개의 시맨틱 연산을 하나의 배치로 적용
- HTTP 세션별 드로잉 선택 상태 분리
- 열려 있는 ExcaliDash 편집 화면에 변경 사항 실시간 반영

```text
MCP 클라이언트
    │
    ├─ stdio ───────────────┐
    │                       │
    └─ Streamable HTTP ─ ExcaliDash MCP ─ HTTPS/REST ─ ExcaliDash
                           :9003/mcp                    v0.6 Agent API
```

## 요구 사항

- ExcaliDash **v0.6.0-dev 이상** (Drawing Agent API 포함)
- Excalidraw 엔진으로 만든 드로잉
- Node.js 20 이상 또는 Docker Compose
- `Read drawings`, `Write drawings` 스코프를 가진 ExcaliDash 계정 API 키
- ExcaliDash Settings에서 활성화된 AI 기능

### ExcaliDash 버전 확인

Drawing Agent API(`ops`, `summary`, `elements`)는 v0.6.0-dev에서 추가되었습니다. v0.5.x에는 해당 엔드포인트가 없어 이 MCP 서버가 동작하지 않습니다.

2026년 8월 기준 안정판은 v0.5.1이고 0.6.0 정식 릴리스는 아직 없습니다. **`:latest` 이미지로 배포했다면 v0.5.x이므로 프리릴리스 태그로 올려야 합니다.**

```yaml
services:
  backend:
    image: zimengxiong/excalidash-backend:0.6.0-dev-a6969c9
  frontend:
    image: zimengxiong/excalidash-frontend:0.6.0-dev-a6969c9
```

`0.6.0-dev-a6969c9`는 특정 빌드에 고정된 태그이고, `dev`는 새 프리릴리스마다 내용이 바뀌는 롤링 태그입니다.

업그레이드 전에 백엔드 볼륨(SQLite DB와 secrets)을 백업하십시오. 마이그레이션 후 이미지만 되돌리는 것은 안전한 롤백이 아닙니다.

버전이 맞는지 확인하려면 API 키로 실제 Agent API를 호출해 봅니다.

```bash
curl -sS -H "Authorization: Bearer $EXCALIDASH_API_KEY" \
  https://your-excalidash/api/drawings/<drawing-id>/summary
```

응답 본문으로 원인을 구분합니다. v0.5.x와 AI 비활성화 상태는 둘 다 `403`이라 상태 코드만으로는 구분되지 않습니다.

| 응답 | 의미 |
|---|---|
| 드로잉 구조 요약 텍스트 | 정상 동작 |
| `{"error":"Forbidden","message":"API key is not authorized for this route"}` | v0.5.x. Agent API가 없어 인증 단계에서 차단됨 |
| `{"error":"AI features disabled",...}` | v0.6이지만 관리자가 AI 기능을 꺼 둠 |
| `{"error":"Drawing not found"}` | 드로잉 ID가 틀렸거나 소유자가 아님 |
| `{"error":"Engine mismatch",...}` | tldraw 드로잉. Excalidraw 드로잉으로 시도해야 함 |

## API 키 발급

ExcaliDash에서 **Settings → API Keys**로 이동합니다. 이름을 입력하고 아래 스코프를 선택한 뒤 키를 생성합니다.

- `Read drawings`
- `Write drawings`

키 전체 값은 생성 직후 한 번만 표시됩니다. `Read collections`, `Write collections`는 이 MCP 서버에서 사용하지 않습니다.

드로잉별 Agent Token은 한 드로잉에만 접근할 때 쓸 수 있습니다. 이 서버에서 목록 조회와 신규 생성을 사용하려면 계정 API 키가 필요합니다.

## Docker로 실행

저장소를 받은 뒤 환경변수 파일을 만듭니다.

```bash
cp .env.example .env
chmod 600 .env
```

`.env`에 ExcaliDash 주소와 API 키를 입력합니다.

```dotenv
EXCALIDASH_URL=http://host.docker.internal:6767
EXCALIDASH_API_KEY=발급받은-키
MCP_PORT=9003
```

ExcaliDash도 같은 호스트의 Docker에서 실행 중이라면 컨테이너 내부의 `localhost`를 사용하면 안 됩니다. macOS·Windows·이 저장소의 Linux Compose 설정에서는 `host.docker.internal`로 호스트에 접근합니다. Tailscale이나 리버스 프록시 주소가 있다면 HTTPS URL을 직접 넣어도 됩니다.

컨테이너를 빌드하고 시작합니다.

```bash
docker compose up -d --build
docker compose ps
```

기본 엔드포인트:

```text
MCP:    http://127.0.0.1:9003/mcp
Health: http://127.0.0.1:9003/health
```

상태와 로그 확인:

```bash
curl --fail http://127.0.0.1:9003/health
docker compose logs -f excalidash-mcp
```

종료:

```bash
docker compose down
```

Compose는 포트를 loopback에만 연결하고 컨테이너를 비루트 사용자, 읽기 전용 root filesystem, capability 제거 상태로 실행합니다.

## GJC에 등록

프로젝트 디렉터리에서 실행합니다.

```bash
gjc mcp add excalidash \
  --project \
  --force \
  --type http \
  --url http://127.0.0.1:9003/mcp
```

생성되는 `.gjc/mcp.json`은 다음과 같습니다.

```json
{
  "mcpServers": {
    "excalidash": {
      "sharing": "per-session",
      "type": "http",
      "url": "http://127.0.0.1:9003/mcp"
    }
  }
}
```

설정 파일을 지정해 GJC를 실행합니다.

```bash
gjc --mcp-config "$PWD/.gjc/mcp.json"
```

사용 중인 GJC 실행 래퍼가 가장 가까운 `.gjc/mcp.json`을 자동으로 찾는다면 평소처럼 `gjc`만 실행하면 됩니다.

도구 이름은 다음 형식으로 노출됩니다.

```text
mcp__excalidash_list_drawings
mcp__excalidash_select_drawing
mcp__excalidash_get_selected_drawing
mcp__excalidash_create_drawing
mcp__excalidash_get_drawing_summary
mcp__excalidash_inspect_drawing_element
mcp__excalidash_apply_drawing_ops
```

예시 요청:

```text
ExcaliDash 드로잉 목록을 보여줘.

"서비스 아키텍처" 드로잉을 선택하고 현재 구조를 요약해줘.

새 드로잉을 만든 뒤 API Gateway, Worker, PostgreSQL을 그리고 흐름대로 연결해줘.
```

## 다른 MCP 클라이언트에 등록

Streamable HTTP를 지원하는 클라이언트에는 아래 URL을 등록합니다.

```text
http://127.0.0.1:9003/mcp
```

클라이언트 설정 형식이 JSON이라면 다음 형태를 사용합니다.

```json
{
  "mcpServers": {
    "excalidash": {
      "type": "http",
      "url": "http://127.0.0.1:9003/mcp"
    }
  }
}
```

## stdio로 실행

Docker 없이 로컬 프로세스로 실행할 수도 있습니다.

```bash
npm ci
npm run build

EXCALIDASH_URL=https://draw.example.com \
EXCALIDASH_API_KEY=발급받은-키 \
npm start
```

stdio 클라이언트 설정 예시:

```json
{
  "mcpServers": {
    "excalidash": {
      "command": "node",
      "args": ["/absolute/path/to/excalidash-mcp/dist/index.js"],
      "env": {
        "EXCALIDASH_URL": "https://draw.example.com",
        "EXCALIDASH_API_KEY": "${EXCALIDASH_API_KEY}"
      }
    }
  }
}
```

## 제공 도구

| 도구 | 설명 |
|---|---|
| `list_drawings` | 드로잉 목록을 페이지 단위로 조회하고 이름으로 검색합니다. |
| `select_drawing` | 이후 호출에서 사용할 기본 드로잉을 선택합니다. |
| `get_selected_drawing` | 현재 MCP 세션에서 선택한 드로잉 ID를 반환합니다. |
| `create_drawing` | 빈 Excalidraw 드로잉을 만들고 기본값으로 선택합니다. |
| `get_drawing_summary` | 이름, 버전, 요소 관계를 담은 구조 요약을 읽습니다. |
| `inspect_drawing_element` | 요소 원본 JSON과 바인딩된 자식 요소를 읽습니다. |
| `apply_drawing_ops` | 최대 50개의 편집 연산을 원자적으로 적용합니다. |

`get_drawing_summary`, `inspect_drawing_element`, `apply_drawing_ops`에 `drawingId`를 직접 전달하면 현재 선택값 대신 해당 드로잉을 사용합니다.

### 편집 연산

| 연산 | 기능 |
|---|---|
| `add_shape` | 사각형, 타원, 다이아몬드, 텍스트, 프레임 생성 |
| `connect` | 두 요소를 화살표 또는 선으로 연결 |
| `set_text` | 텍스트 변경 |
| `set_style` | 색상, 채우기, 선, 투명도, 글꼴 등의 스타일 변경 |
| `move` | 상대 거리 또는 절대 좌표로 이동 |
| `resize` | 너비와 높이 변경 |
| `align` | 좌우·상하·가운데 정렬 |
| `distribute` | 가로 또는 세로 간격 분배 |
| `layout` | 가로, 세로, 그리드 자동 배치 |
| `group` | 여러 요소 그룹화 |
| `delete` | 요소 삭제 |
| `import_elements` | Excalidraw 요소 배열 가져오기 |
| `revert_to_snapshot` | 지정한 스냅샷 버전으로 복원 |

배치 예시:

```json
{
  "ops": [
    {
      "op": "add_shape",
      "ref": "api",
      "shape": "rectangle",
      "x": 100,
      "y": 100,
      "w": 240,
      "h": 100,
      "label": "API Gateway"
    },
    {
      "op": "add_shape",
      "ref": "db",
      "shape": "rectangle",
      "x": 500,
      "y": 100,
      "w": 240,
      "h": 100,
      "label": "PostgreSQL"
    },
    {
      "op": "connect",
      "fromId": "api",
      "toId": "db",
      "label": "query"
    }
  ],
  "clientBatchId": "architecture-001"
}
```

같은 배치에서 만든 요소는 `ref` 값으로 참조합니다.

## 환경변수

| 이름 | 필수 | 기본값 | 설명 |
|---|---:|---|---|
| `EXCALIDASH_URL` | 예 | 없음 | ExcaliDash 공개 URL 또는 내부 URL. `/api`는 생략해도 됩니다. |
| `EXCALIDASH_API_KEY` | 예 | 없음 | `Read drawings`, `Write drawings` 스코프를 가진 계정 API 키 |
| `EXCALIDASH_TOKEN` | 아니요 | 없음 | 이전 설정과의 호환을 위한 API 키 별칭 |
| `EXCALIDASH_DRAWING_ID` | 아니요 | 없음 | 시작할 때 선택할 기본 드로잉 ID |
| `MCP_HTTP_HOST` | HTTP만 | `0.0.0.0` | 컨테이너 내부 HTTP 바인드 주소 |
| `MCP_HTTP_PORT` | HTTP만 | `8080` | 컨테이너 내부 HTTP 포트 |
| `MCP_MAX_BODY_BYTES` | 아니요 | `10485760` | HTTP 요청 본문 최대 크기 |
| `MCP_MAX_SESSIONS` | 아니요 | `64` | 동시에 유지할 MCP 세션 수 상한. 초과하면 `429`를 반환합니다. |
| `MCP_SESSION_IDLE_MS` | 아니요 | `1800000` | 유휴 세션을 정리하기까지의 시간(밀리초) |
| `MCP_PORT` | Compose만 | `9003` | 호스트 loopback에 공개할 포트 |

## 보안

HTTP MCP 엔드포인트에는 별도 인증 계층이 없습니다. 기본 Compose처럼 반드시 `127.0.0.1`에만 포트를 연결하거나 인증된 내부 프록시 뒤에 두십시오. `0.0.0.0:9003:8080`처럼 LAN에 직접 공개하지 마십시오.

### 네트워크 노출

HTTP 서버는 `/mcp` 요청에 Host·Origin 검증을 적용하고, 요청 본문 크기와 동시 세션 수를 제한하며, 잘못된 요청 헤더가 프로세스를 중단시키지 못하도록 요청 처리를 격리합니다.

Host 헤더 검증은 브라우저발 DNS 리바인딩만 막습니다. 직접 접속하는 공격자는 Host 값을 위조할 수 있으므로 실제 접근 통제는 loopback 바인딩이나 앞단 프록시가 담당해야 합니다.

### API 키 취급

계정 API 키에는 사용자가 소유한 드로잉을 조회하고 수정할 권한이 있습니다.

- `.env`를 Git에 커밋하지 마십시오.
- API 키를 로그, 이슈, 스크린샷에 남기지 마십시오.
- 필요한 스코프만 발급하십시오.
- 키가 노출되면 ExcaliDash Settings에서 폐기하고 새 키를 발급하십시오.

## 제한 사항

- Agent API 편집은 Excalidraw 엔진만 지원합니다. tldraw 드로잉은 `ENGINE_MISMATCH` 오류를 반환합니다.
- 컬렉션 스코프를 받아도 현재 MCP 도구는 컬렉션 CRUD를 제공하지 않습니다.
- 드로잉 삭제 도구는 제공하지 않습니다. `delete` 연산은 드로잉 안의 요소를 삭제합니다.
- HTTP 세션이 종료되면 선택한 드로잉 상태도 사라집니다. `drawingId`를 직접 전달하면 선택 상태에 의존하지 않습니다.

## 개발

```bash
npm ci
npm test
npm run build
npm run start:http
```

Docker 이미지 빌드:

```bash
docker build -t excalidash-mcp:local .
```

테스트에는 HTTP 헬스체크, stdio MCP 호출, Streamable HTTP 세션 상태, ExcaliDash API 요청 형식 검증이 포함됩니다.

## 문제 해결

### `403 Forbidden`

세 가지 원인이 같은 상태 코드를 씁니다. 응답 본문으로 구분합니다.

- `API key is not authorized for this route` — ExcaliDash가 v0.5.x입니다. [버전 확인](#excalidash-버전-확인)을 참고해 업그레이드합니다.
- `AI features disabled` — Settings에서 AI 기능을 켭니다.
- 그 외 — API 키에 `Read drawings`, `Write drawings` 스코프가 있는지 확인합니다.

### `401 Unauthorized`

API 키 값이 잘못되었거나 폐기되었습니다. Settings에서 새 키를 발급합니다.

### 컨테이너에서 ExcaliDash에 연결할 수 없음

`EXCALIDASH_URL=http://localhost:6767`을 사용하지 않았는지 확인합니다. 같은 호스트의 서비스에는 `http://host.docker.internal:6767`을 사용합니다.

### `No drawing selected`

`list_drawings` 후 `select_drawing`을 호출하거나 도구 인자에 `drawingId`를 전달합니다.

### `ENGINE_MISMATCH`

대상 드로잉이 tldraw 엔진으로 생성되었습니다. Excalidraw 드로잉을 선택하거나 새로 만드십시오.

### 9003 포트를 이미 사용 중

`.env`에서 호스트 포트를 바꿉니다.

```dotenv
MCP_PORT=9010
```

MCP 클라이언트 URL도 `http://127.0.0.1:9010/mcp`로 변경해야 합니다.

## 라이선스

[MIT License](LICENSE)
