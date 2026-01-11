# SpeechAce Practice (Next.js + Vercel + Cloudflare R2)

Web app luyện nói/đọc với SpeechAce:

- **Reading (scripted)**: nhập reference text → chấm theo `word_score_list` → highlight từ sai, click để nghe lại đúng từ.
- **Open-ended**: chấm speech theo prompt (relevance_context) + **IELTS feedback**.
- **Relevance**: chấm “đúng trọng tâm” theo `relevance_context` + **IELTS feedback**.
- Upload audio thẳng lên **Cloudflare R2** bằng **presigned PUT URL**.
- Backend lấy audio từ R2 → forward sang SpeechAce.
- (Optional) gửi kết quả về **Telegram group**.

---

## 1) Setup ENV (Local)

Copy `.env.example` → `.env.local` và điền:

- `SPEECHACE_KEY`
- `SPEECHACE_TEXT_ENDPOINT` (scripted reading)
- `SPEECHACE_SPEECH_ENDPOINT` (open-ended + relevance)
- R2: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
- (Optional) Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- (Optional) `R2_PUBLIC_BASE_URL` (chỉ để show link audio public trong Telegram)

---

## 2) Run local

```bash
npm i
npm run dev
```

Mở `http://localhost:3000`

---

## 3) Deploy Vercel

1. Push repo lên GitHub
2. Vercel → Import Project
3. Vercel → **Settings → Environment Variables**
   - add đủ các key giống `.env.local`
4. Redeploy (Deployments → Redeploy) để env có hiệu lực

> Nếu Vercel báo `Missing env: SPEECHACE_KEY` nghĩa là bạn chưa set env trong Vercel (hoặc set sai Environment scope).

---

## 4) Cloudflare R2 notes

- Bucket private là ổn (khuyến nghị). App sẽ phát lại audio bằng signed URL qua `/api/audio-url`.
- `R2_PUBLIC_BASE_URL` **không bắt buộc**. Chỉ dùng nếu bạn muốn **Telegram** nhận được link audio public.

---

## 5) Thêm / sửa văn mẫu

Sửa `lib/passages.ts` và deploy lại.
