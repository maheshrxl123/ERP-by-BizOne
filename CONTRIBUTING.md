# Contributing to BizOne ERP

Thank you for helping improve BizOne ERP!

## Development Workflow
1. Fork and clone the repository.
2. Copy `.env.example` to `.env` and fill in your Supabase project credentials and a 64-character hex `APP_ENCRYPTION_KEY`.
3. Run migrations (`0001` through `0013` in `/supabase/migrations`) via `npm run setup`.
4. Start the local server with `npm run dev` (Express + Vite on port 3000).

## Code & UI Standards
- **TypeScript Strict**: All client and server code must pass `npm run lint` (`tsc --noEmit`).
- **Database Integrity**: All accounting, stock, billing, and Khata mutations run inside transactional PostgreSQL `SECURITY DEFINER` RPCs with `SET search_path = public`.
- **Phone-First Design**: Keep mobile bottom navigation at 5 controls, ensure `>=44px` touch targets, support bilingual EN/HI copy, and maintain WCAG AA contrast in both Light and Dark themes.
- **No Mock Fallbacks or Client Secrets**: Never commit `.env` files, API keys, or mock credentials.

## Pull Request Checklist
- [ ] `npm run check-env`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm test`
