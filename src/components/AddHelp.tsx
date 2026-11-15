/** How to add many photos at once: the iPhone photo picker has no "select all". */
export function AddHelp() {
  return (
    <details class="add-help">
      <summary>Adding lots of photos at once</summary>
      <p><strong>Quick way:</strong> tap Choose photos → Photo Library. Tap one photo and, without lifting your finger, drag across and down to select many at once.</p>
      <p><strong>A whole album:</strong></p>
      <ol>
        <li>In the Photos app, open the album → <em>Select</em> → <em>Select All</em> → Share → <em>Save to Files</em>. (Under Options, pick Format: Current to keep full quality and dates.)</li>
        <li>Here, tap Choose photos → <em>Choose File</em> → open that folder → <em>Select</em> → <em>Select All</em> → Open.</li>
        <li>When it's done you can delete that folder from Files. The app keeps its own copy.</li>
      </ol>
      <p class="muted small">Adding the same photo twice is fine: duplicates are skipped.</p>
    </details>
  );
}
