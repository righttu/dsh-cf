# Archived: snapshot restore from 16 GB to 8 GB

The experiment UI, routes, SnapshotLab class, container configuration and binding were removed after the completed test. Do not restore them during routine console changes.

## Observed result (user-supplied cloud runtime output, 2026-11-09)

All four stages completed: fresh image at 8000 MB; same image at 16000 MB and snapshot creation; that snapshot restored at 16000 MB; the SAME snapshot restored at 8000 MB. CPU was fixed at 1 vCPU, memory 3072 MiB. No R2 directory restore was used. Test containers were stopped after each step.

Both /data/snapshot-lab-marker.txt and /opt/snapshot-lab-marker.txt matched SHA-256 after both snapshot restores. In the final stage, statfs, df and lsblk all reported 8,000,000,000 bytes (the source reported 16,000,000,000). Root filesystem was Btrfs on /dev/vdb. Snapshot handle size was 5174 bytes; this must not be treated as total root filesystem usage or minimum restore capacity.

This disproves a blanket rule that a 16 GB-origin snapshot cannot start on an actual 8 GB disk. It does not establish the platform's private snapshot implementation, arbitrary size-pair compatibility, full DSH context validation, or near-full-disk behavior. Only two small markers were explicitly hash-verified.

## Current application choice

Instance switching continues to use a fresh R2 backup of /data, a source safety snapshot, a newly started target image+instance, and directory restore. Shrinking the target disk is no longer blanket-prohibited. Insufficient capacity or startup/restore/validation failure leaves the source checkpoint available for explicit recovery; no automatic retry or task replay.

Files outside /data are NOT migrated by this R2 path. A same V1/V2 label refers to its currently configured image, not an immutable historical image selected through the UI.

Official sources:
- https://developers.cloudflare.com/containers/guides/snapshots/
- https://developers.cloudflare.com/containers/api/durable-object-container/#start

The public docs examined did not specify smaller-disk snapshot compatibility. Runtime success above is experimental evidence, not a universal official guarantee. Removing the experiment does not claim that stored platform snapshots were deleted; snapshot retention follows platform policy.
