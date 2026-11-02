# HÊU — studio video AI

App Windows tạo video AI hàng loạt (giống ViraAI) và có thêm:

- **Claude trên máy** viết kịch bản liền mạch, dựng bộ nhân vật, kiểm tra nhất quán, phân tích video đối thủ. Dùng gói Claude Pro/Max của bạn, không cần API key.
- **Đồng nhất nhân vật**: mô tả ngoại hình, trang phục, giọng nói và phong cách được *code* chèn nguyên văn vào mọi prompt. Mỗi cảnh gửi kèm ảnh tham chiếu nhân vật. Cảnh "nối liền" lấy khung cuối của clip trước làm khung đầu clip sau.
- **Prompt ảnh tham chiếu**: bảng nhân vật 4 góc, ảnh cận mặt, bảng biểu cảm, ảnh bối cảnh. Bấm một nút là tạo ảnh bằng Nano Banana Pro hoặc Muse, ảnh tự gắn vào nhân vật.
- **Veo 3.1** (Fast / Lite / Quality), **Gemini Omni Flash** và **Meta Muse**, đều chạy qua useapi.net, mỗi bên một API riêng.
- **Hàng đợi render**: chạy song song, tự thử lại, tự tải về, đóng app mở lại vẫn chạy tiếp, ghép phim bằng FFmpeg.
- **Bảng giá**: các gói bán phần mềm (bạn sửa được) cùng chi phí credit cho từng model và cho từng dự án.
- **Nhân bản dự án** (làm biến thể hoặc “Phần 2” giữ nguyên nhân vật) và **Thùng rác** khôi phục được dự án đã xóa.
- **Render nhiều luồng**: chọn 1–10 luồng ngay trên màn hình, giới hạn riêng cho Veo/Flow và Muse.
- **Kết nối Claude Desktop (MCP)**: chat với Claude Desktop "viết kịch bản cho dự án X" là Claude đọc và ghi thẳng vào app.

## 1. Lấy bộ cài .exe (không cần cài gì thêm)

1. Tạo repo mới trên GitHub (ví dụ `h2-video-studio`) rồi tải toàn bộ thư mục này lên.
2. Mở tab **Actions**. Workflow **Build bộ cài Windows** tự chạy, mất khoảng 5–8 phút.
3. Bấm vào lần chạy đó, kéo xuống mục **Artifacts** rồi tải **HEU-Setup**. Giải nén ra được `HEU-Setup-1.1.0.exe`.
4. Chạy file .exe để cài. Windows có thể cảnh báo SmartScreen vì app chưa ký số: bấm *More info → Run anyway*.

Muốn có bản phát hành cố định thì gắn tag `v1.0.0` rồi push. Bộ cài sẽ nằm trong mục **Releases**.

## 2. Cài đặt lần đầu trong app

**Claude trên máy**
1. Mở PowerShell và chạy: `irm https://claude.ai/install.ps1 | iex`
2. Mở cửa sổ PowerShell mới, gõ `claude` rồi đăng nhập tài khoản Claude Pro/Max (gói Free không dùng được Claude Code).
3. Trong app, vào **Cài đặt** và bấm **Kiểm tra Claude**.

**API Veo 3 và API Meta Muse — nhập riêng, chỉ cần bên bạn dùng**

Trong **Cài đặt → ① API tạo video** có 2 ô tách riêng. Dùng Veo 3 thì chỉ nhập API Veo 3, dùng Muse thì chỉ nhập API Muse; app chỉ đòi API của model đang chọn.

- *API Veo 3* (Veo 3.1 Fast/Lite/Quality, Gemini Omni Flash, ảnh Nano Banana/Imagen): đăng ký useapi.net, lấy token, thêm tài khoản Google Flow (cần gói Google AI Pro/Ultra), dán token vào ô **API Veo 3** → **Kiểm tra Veo 3**.
- *API Meta Muse* (video Muse, ảnh Muse Image): lấy token useapi.net, thêm tài khoản Meta Muse (đăng nhập bằng email + mật khẩu, gói miễn phí ~30–50 video/tuần), dán token + email Muse vào ô **API Meta Muse** → **Kiểm tra Muse**.
- Một tài khoản useapi.net có cả hai thì dán cùng token vào cả hai ô. Bản cũ chỉ có 1 ô token sẽ được tự chuyển sang ô mới khi mở app.

**Veo 3 qua Chrome (không cần token)** — Cài đặt → khung Veo 3 → *Tiện ích Chrome*: bấm *Mở thư mục tiện ích*, nạp thư mục đó ở `chrome://extensions` (Developer mode → Load unpacked), dán mã ghép nối vào tiện ích **HÊU Flow Helper**, rồi mở một dự án trên flow.google.com. HÊU giao từng prompt, tiện ích dán vào Flow, bấm Tạo và gửi file về. Mã nguồn tiện ích nằm ở `flow-extension/`, cầu nối ở `src/core/bridge.js` (chỉ nghe 127.0.0.1, cần mã ghép nối).

Trong app, mỗi trang có nút **? Hướng dẫn** mở đúng mục giải thích tác dụng và cách dùng từng nút.

## 3. Làm một phim

1. **Phân tích đối thủ**: dán link video viral và bấm Phân tích, rồi chọn **Tạo dự án từ ý tưởng này**.
2. **Ý tưởng & phong cách**: chọn model, khung hình, ngôn ngữ thoại rồi bấm **Claude dựng phong cách & nhân vật**.
3. **Nhân vật & bối cảnh**: đọc lại phần khóa nhận dạng. Bấm **Prompt ảnh tham chiếu → Tạo ảnh**, hoặc thêm ảnh có sẵn.
4. **Kịch bản**: bấm **Claude viết kịch bản**. Có thể sửa tay hoặc nhờ Claude viết lại từng cảnh.
5. **Prompt & kiểm tra**: xem lỗi tự động, bấm **Claude kiểm tra** rồi áp dụng các sửa đề xuất.
6. **Render & ghép phim**: render, chọn bản đẹp nhất của từng cảnh rồi bấm **Ghép phim**.

Ngoài ra có trang **Tạo nhanh**, làm việc giống ViraAI: mỗi video cách nhau một dòng trắng, gõ `@` để chèn nhân vật đã khóa.

## Cấu trúc mã

| Thư mục | Nội dung |
|---|---|
| `main.js`, `preload.js` | Tiến trình chính Electron, IPC |
| `renderer/` | Giao diện (HTML/CSS/JS thuần) |
| `src/core/compiler.js` | Trình ghép prompt có khóa nhân vật, kiểm tra lỗi |
| `src/core/brain.js` | Các câu lệnh giao cho Claude (bible, kịch bản, kiểm tra, đối thủ) |
| `src/core/claude.js` | Gọi `claude -p` trên máy |
| `src/core/providers/useapi.js` | Veo 3.1 / Omni Flash / Nano Banana / Muse |
| `src/core/queue.js` | Hàng đợi render, nối khung, thử lại |
| `src/core/media.js` | FFmpeg (khung cuối, ghép phim), yt-dlp (lấy phụ đề đối thủ) |
| `src/core/pricing.js` | Bảng giá và ước tính chi phí |
| `src/mcp/server.js` | MCP server cho Claude Desktop |
| `test/run-tests.js` | bài kiểm tra phần lõi (`npm test`) |

Chạy từ mã nguồn (cần Node 22): `npm install` rồi `npm start`. Build bộ cài trên máy: `npm run dist`.

## Lưu ý

- Giá credit và giới hạn model lấy theo tài liệu useapi.net / Google Flow tại thời điểm 10/2026. Có thể sửa trong `src/core/models.js` và trong Cài đặt → Đơn giá.
- Bản preview Veo 3.1 trên Gemini API đã bị Google tắt từ 22/10/2026, vì vậy app đi qua Google Flow (useapi.net).
- Meta chưa mở API chính thức cho Muse. useapi.net điều khiển tài khoản Muse của bạn, nên chỉ dùng tài khoản đó cho API.
