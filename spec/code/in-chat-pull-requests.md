---
title: "In-chat pull requests"
area: code
split-from: SPEC.md (2026-10-22)
---

# In-chat pull requests

Updated 2026-10-02. Open pull-request cards lead with the actual GitHub head branch, with repository, PR number and target branch retained as secondary context. Until live metadata arrives, the label uses the repository and PR number from the URL rather than inventing a branch. Open and closed cards share the merged banner's compact rounded layout with a faint neutral wash, no enclosing border, and slim borderless actions. Approve keeps a green text cue, Decline keeps a danger cue, and Merge uses neutral ink; filled gradients and purple are reserved for the unchanged merged celebration. Existing action confirmation and disabled states remain intact.

Reading files or searching code does not create PR cards from example URLs in tests or documentation. Explicitly discussed PR links and shell output, including `gh pr create`, still surface cards.
