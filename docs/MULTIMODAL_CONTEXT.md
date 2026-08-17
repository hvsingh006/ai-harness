# Multimodal context and representation coverage

AI Harness 0.8.0 treats the original resource version as authoritative and every extracted/rendered/OCR form as a replaceable representation of that exact immutable version.

## Representation model

`resource_representations` links:

- Project Space, logical resource, and immutable `resource_version_id`;
- representation kind and processing status;
- optional private-vault artifact;
- page and region provenance;
- extractor/version, content SHA-256, confidence, and trust class;
- bounded processing/coverage metadata.

Kinds implemented in 0.8.0 are `original_source`, `original_visual`, `pdf_metadata`, `digital_text`, `page_image`, `embedded_image`, and `ocr_text`. Retrieval chunks point back to a representation and record source kind, authority, confidence, page/line, and region data. Normal retrieval always joins through the logical resource's current version. Old versions and their representations remain retained but do not leak into current queries.

## PDF pipeline

The bounded local pipeline uses Poppler and Tesseract with argument arrays and `shell: false`:

1. enforce the immutable input-byte limit;
2. inspect metadata/page count/encryption with `pdfinfo`;
3. extract digital text one page at a time with `pdftotext`;
4. render bounded page images at 144 DPI with `pdftoppm`;
5. OCR each rendered page to TSV with Tesseract;
6. extract embedded raster images with `pdfimages` where practical;
7. archive derived artifacts content-addressed under private state;
8. index digital/OCR chunks with version/page/region provenance;
9. remove the processing scratch directory in a `finally` path.

Encrypted PDFs, page/input/pixel/output/time limits, missing tools, tool failures, and partial pages are explicit coverage failures. No cached older representation is substituted. PDF digital/OCR overlap is compared per page; highly overlapping OCR is retained as an auditable representation but excluded from duplicate retrieval chunks.

Large PDFs are incremental. Up to 5,000 pages can be admitted, but documents over 80 pages process only pages 1–24 during the interactive ingest pass. Coverage records total, processed, pending, and on-demand page numbers. A request such as “inspect page 430 of handbook.pdf” materializes page 430 from the immutable current version, renders and OCRs that page, records the new page-linked representations/chunks, and performs OCR-based secret analysis before it becomes eligible. If the exact page cannot be safely prepared, Harness may deliver the whole current PDF only when its complete representation/security coverage and surface byte limit are satisfied; otherwise the turn is blocked. It never substitutes page 1 or a similarly named image.

## Images

PNG, JPEG, and WebP keep an immutable original visual and are sent to Tesseract when supported by the installed Leptonica build. OCR output includes bounded text, average confidence, and word-line regions. SVG remains an original visual plus safely decoded source text; it is not raster-OCR'd.

Harness makes no claim that OCR understands layout, diagrams, color, or visual meaning. A future `VisualAnalyzer` can register as another representation producer without changing original authority or weakening surface/security contracts.

## Coverage versus freshness

Freshness answers: “Are these the latest authoritative bytes?” Representation coverage answers: “Which useful views of those bytes were successfully produced?” They are deliberately separate.

- `complete`: requested built-in representations succeeded;
- `partial`: original is current but one or more derived forms failed/unavailable;
- `attachment_only`: original is retained and can be attached, but no text parser is claimed;
- `source_only`: original is retained without a derived textual/visual form;
- `blocked`: processing could not establish the minimum representation for that resource.

A Project Space can have current bytes with partial visual coverage. The delivery planner must then attach a supported current visual/file, use an explicit OCR/text fallback, or block the visual-dependent send. It cannot silently claim visual understanding.

## Security

OCR and PDF-extracted text pass through the same deterministic outgoing secret scanner as source text. OCR retained only as an auditable representation because it duplicates digital text is still scanned independently, so retrieval deduplication cannot hide an OCR-only credential. High-confidence findings make that version local-only; lower-confidence token families are redacted at send time. Findings store rule/confidence/fingerprint, not plaintext secrets. Prompt-injection-like OCR remains searchable evidence but is labeled `untrusted_derived` and cannot modify policy, instructions, permissions, or tool scope.

Visual/file delivery additionally requires exact `clear` security state. Page images and original images remain ineligible when OCR security analysis is missing, blocked, or requires redaction; binary pixels cannot be safely text-redacted. Whole PDF/image originals also require complete representation coverage. This is intentionally stricter than retaining the bytes locally. The audit/representation metadata states that visual secret analysis is OCR-based and is not a mathematical guarantee that every visible secret was recognized.

## Reprocessing

Resource Library exposes **Retry processing** for one current version and **Rebuild derived data** for the Project Space. These fixed jobs rebuild derived rows/artifacts from retained originals, show progress/failure, preserve every original/version/chat/audit, and never accept a command or arbitrary output path.
