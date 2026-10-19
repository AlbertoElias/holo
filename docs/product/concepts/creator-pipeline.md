# Creator Pipeline And Content Lifecycle

**Layers:** All layers (supporting delivery).

**Status:** Supporting ideas, not approved architecture or delivery work.

The [historical 90-day proposal](../research/historical-productization-plan.md)
identified practical gaps between making a recording and having someone receive
it. These capabilities can support many communication tasks, but infrastructure
investment should follow an actual workflow and evidence of friction.

## Create, Publish, Process, Receive

- **IDEA-046 Direct publishing:** offer "Publish to HoloIM" after export with
  title, creator, and optional tags. Keep a local export path and make recording
  loss on failure avoidable. Publishing is distinct from recording or editing.
- **IDEA-057 Upload recovery:** show progress and a failed attempt that can be
  retried or resumed without losing asset or metadata. Decide what resumable
  means before promising recovery across reloads or devices.
- **IDEA-047 Processing lifecycle:** distinguish accepted uploads from usable
  messages. The proposed states are uploaded, processing, ready, and failed;
  store actionable failure reasons. These asset states are unrelated to the
  product knowledge lifecycle (Idea -> PRD -> Decision).
- **IDEA-048 Metadata:** extract duration, audio presence, and rough polygon
  count. Define accuracy and units rather than displaying guesses as facts.
- **IDEA-049 Preview images:** generate recognizable thumbnails. A representative
  moment should help a recipient find the right explanation, not hide content.
- **IDEA-050 Artifact jobs:** durable background conversion and extraction,
  including USDZ, retries, timeouts, recovery of stale locks, and persisted
  errors. Partial success needs a policy: a playable GLB may lack an AR artifact.

## Find, Trust, Operate

- **IDEA-051 Discovery:** text search, tags, creator/latest filters, creator
  profiles, and stable cursor pagination. Engagement signals are exploratory;
  understanding or finding an explanation may matter more than time in a feed.
- **IDEA-052 Identity:** basic session/token auth and creator ownership.
  Private workspaces are a portfolio option, not implied by adding login.
- **IDEA-053 Moderation:** hide/report primitives and admin review. Clarify
  private hiding versus removal for everyone, and visibility while under review.
- **IDEA-054 Storage:** object store/CDN and signed URLs when durability,
  distribution, or access requirements warrant them.
- **IDEA-055 Limits:** request/upload limits, quotas, rate limiting, and abuse
  controls matched to actual creators and recipient access needs.
- **IDEA-056 Operations:** structured logs, metrics, error dashboards, and
  explicit service objectives for upload latency and processing completion.

## Contracts And Evidence

The historical proposal contains precise DTO additions, endpoint suggestions,
and upload/processing/pagination test cases. They are preserved there rather
than silently adopted as the current API. Preserve existing fields and the
export -> upload -> render flow; review compatibility before changing responses.

## Open Questions

- Which pipeline step currently stops people making a second message?
- Does ready mean playable in-browser, or complete on every supported AR path?
- How do authors discover and recover from a failed derived artifact?
- Which identity, safety, storage, and service needs follow from the first
  chosen use case, rather than an assumed public social network?
