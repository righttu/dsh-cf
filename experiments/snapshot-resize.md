# Snapshot 16 GB -> 8 GB isolated runtime experiment

Official sources:
- https://developers.cloudflare.com/containers/guides/snapshots/
- https://developers.cloudflare.com/containers/api/durable-object-container/#start

The public contract exposes snapshot+instance but does not specify smaller-disk restore compatibility or disclose whether snapshots are block-level, layered, or file-level internally. Do not infer implementation from a successful restore.

## Run after deployment

Visit https://dsh.righttu.uk/snapshot-lab through the same Access login. Click Execute next step four times, waiting for each response. GET refresh is read-only. The existing console is unchanged. All write routes use the existing Access identity and same-Origin guards.

The separate SnapshotLab Durable Object/container never addresses the DshAgent owner, AI, browser, or R2. It uses the DSH image with an overridden sleep entrypoint, no Internet, no model calls. Only its own container is stopped. Root markers live under /data and /opt. Each step ends with destroy; inactivity timeout is 120 seconds and the entrypoint exits after 600 seconds. Timed-out/interrupted or failed controls require explicit reset, never automatic replay.

Fixed vcpu=1, memoryMib=3072. Disk values are MB: 8000 and 16000, not GiB.
1. Fresh image -> 8000 MB; collect filesystem and block/mount evidence.
2. Same immutable image -> 16000 MB; write two tiny markers, hash, measure, snapshot.
3. That snapshot -> 16000 MB; verify both hashes, measure.
4. SAME snapshot -> 8000 MB; verify both hashes, measure.

Capture JSON for all steps. Calling start() without an exception is not a pass: exec and output must complete. Preserve synchronous and asynchronous startup errors. Compare filesystem.totalBytes, df, lsblk and mountinfo against both image baselines. A successful restore with unchanged 16 GB capacity does not establish effective disk shrinking. Container-visible filesystem evidence does not independently prove platform billing or provisioned backing capacity.

This first experiment has tiny data. It does not validate snapshots with >8 GB of files, different filesystem features, every size pair, or a platform guarantee. Do not fill production disks for a follow-up. Snapshot handles expire per platform policy; reset retains the immediately previous record but does not delete snapshots (the Worker snapshot API provides no delete method). Active runtime and snapshot storage incur normal charges.

## Status

Prepared only. No real cloud execution result is recorded here. CI unit tests use test doubles and cannot establish runtime support.
