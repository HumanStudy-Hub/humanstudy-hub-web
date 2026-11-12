# Paired community submissions

A paired Desktop ZIP includes `program.json`, the draft `study.json`, the strict
`protocol.json` projection, `sources/SOURCE.json`, any included licensed open
sources and shareable research artifacts. It uses `CONTRIBUTION.json` schema
version 2 with `kind: "protocol"` and an exact payload manifest.

The uploader reviews the actual files and confirms public submission before upload.
The Web checks archive paths and hashes, the program's raw protocol SHA-256, the
study identity and version, and the matching source files and declared licenses.
This intake supports hosted sources only. A projection with held text, incomplete
source declarations, restored material, or contributor-supplied review claims
must be exported again. Review free text for sensitive information before sharing.
The file checks cannot determine whether every disclosure is appropriate.

The Hub opens a public GitHub proposal marked **User submitted**. It preserves
the reviewed payload bytes and regenerates contribution metadata with the
public attribution and exact file list. The upload does not change the public
library recommendation, make the draft runnable, or grant a validation badge.

Desktop computes the study's hsenv canonical protocol hash. The Web checks the
hash field's shape and checks the program's raw hash against actual protocol bytes.
Bench remains responsible for the engine's canonical hash and full release checks.
The current Bench release validator requires curated fidelity and can reject a
community draft. A maintainer must review it before any library publication.

To verify a Desktop export without publishing a test proposal, set
`HUMANSTUDY_DESKTOP_PAIRED_ZIP` to the fixture archive and run
`node --test tests/community.test.mjs`. The test runs the real archive parser and
publisher and compares the captured GitHub proposal files to the original ZIP.
