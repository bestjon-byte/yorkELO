# Deploy to Vercel

Commit all modified tracked files and push to `origin/main`, which triggers an automatic Vercel deployment.

## Steps

1. Run `git status` to see what has changed and `git diff --stat` for a summary.
2. Run `git log --oneline -3` to understand recent commit message style.
3. Stage only the relevant source files (never stage `.env*`, secrets, or large binaries). Use specific file paths, not `git add -A`.
4. Write a concise commit message that summarises **what** changed and **why**. Group related changes into bullet points. End with the co-author trailer.
5. Commit, then `git push origin main`.
6. Confirm the push succeeded and remind the user that Vercel will deploy automatically (usually within ~30 seconds).

## Commit message format

```
<Short one-line summary (≤72 chars)>

- Bullet point for each logical change group
- Use present tense ("Add", "Fix", "Update", not "Added")

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

## Notes

- Do NOT commit `*.png`, `*.env`, `node_modules/`, or files already in `.gitignore`.
- Do NOT force-push or amend published commits.
- If there is nothing to commit, say so clearly rather than making an empty commit.
- The Vercel project is connected to `https://github.com/bestjon-byte/yorkELO.git` — every push to `main` deploys to `https://york-elo.vercel.app`.
