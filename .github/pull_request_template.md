## What this changes



## Checklist

- [ ] `node --test test/` passes
- [ ] Still read-only: nothing asks for edits or writes a file
- [ ] Every path goes through `Workspace.resolve`
- [ ] No network, shell or dependencies
