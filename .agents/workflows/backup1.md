---
description: Restore to backup1 - the stable version before Gemini cross-check
---
// turbo-all

1. Checkout the backup1 tag:
```powershell
git checkout backup1 -- .
```

2. Stage and commit:
```powershell
git add -A
git commit -m "revert: restore backup1"
```

3. Push to remote:
```powershell
git push origin master
```
