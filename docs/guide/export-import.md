# Export and import

You can save a board as an image, a file you can reopen, or text. You can also bring a saved board or a Mermaid diagram into Tabula.

## Export

Open the board menu (the three-dot **Menu** button at the top right). The **Export** section lists every format. If you have items selected, the heading reads **Export selection** and PNG, SVG and JSON contain those items, contents of selected frames or groups, and connectors between exported items.

| Item | What you get |
|---|---|
| **PNG image** | A 2x raster image on a white background. |
| **SVG vector** | A scalable image on white. |
| **Board file (.drift)** | The whole board with its history, for backup or moving it. |
| **JSON snapshot** | A readable copy of the board. |
| **Markdown summary** | Text notes grouped by frame, with votes and poll results. |
| **Copy as Mermaid** | Mermaid text copied to your clipboard. |
| **Cards as CSV** | One row per kanban card, for spreadsheets. Shown when the board has a kanban. See [Kanban boards](kanban.md#export-cards-as-csv). |

Files are named after the board.

### PNG and SVG

Images use the light default colours on white whatever theme you are using. Comment pins are left out. PNG and SVG exports fetch fonts used by the board while exporting and embed available WOFF2 files; opening an exported SVG makes no Fontshare request. If a font cannot be fetched or the combined raw font data would exceed 1.5 MB, that font falls back to a system font. Very large PNG boards are scaled down to fit a maximum image size.

### Board file (.drift)

A `.drift` file holds the complete board, including comments, polls and votes, the board's edit history and its [pictures](images.md). It is the most faithful copy. Use it to back up a board or hand it to someone else.

### JSON snapshot

A text file with the board's settings, objects, session steps, comments and polls. It does not include edit history. With a selection, it contains the selected objects, visible descendants of selected frames or groups, connectors between included objects and selected connectors whose bound ends are included. It leaves out hidden objects and does not include a selected object's containing frame or group unless that ancestor is selected too.

### Markdown summary

Lists each frame as a heading with its notes as bullets, sorted by votes (shown as "3 votes"), followed by revealed poll results. Only items with text inside frames are included.

The summary writes your text literally: a title such as `# heading` or `![x](link)` stays plain text and never turns into a heading, an image or a link. To keep it that way the raw `.md` file may show a backslash before characters such as `#`, `[` or `*`; a Markdown viewer hides them.

Kanbans are listed too: a heading for each kanban, its lanes below it and the cards as bullets. See [Kanban boards](kanban.md#in-the-markdown-summary).

The summary leaves out what is still hidden from you on the board. During a [private writing](sessions.md#private-writing) step it does not list other people's notes until they are revealed, and during a vote it shows no vote counts until the totals are revealed. Counts of a finished vote are included. See [Polls](polls.md).

### Copy as Mermaid

Copies a diagram description to the clipboard: a class diagram if the board has UML classes, otherwise a flowchart. Only connectors joining two shapes are included. You can also use **Copy as Mermaid** in the properties panel for a selection of shapes or classes.

## Import

### Open a file as a new board

On the home screen click **Import file** and choose a `.drift` or `.json` file. It opens as a new board, zoomed to fit, with the message "Board opened from file". A `.drift` file restores comments, polls and history. A JSON file restores objects, settings, session steps and polls, and comments if present.

### Add a file to the current board

In a board, choose **Import a board file into this board** in the board menu, or drag a `.drift` or `.json` file onto the board. The objects are added to the right of what is already there and the view moves to them. Comments, polls and settings from the file are not added. Imported items get new identities, so importing the same file twice makes two copies.

You need edit access. If the file is not a Tabula board, or was made by a newer version of Tabula, you get a message and nothing changes.

### Importing Mermaid

Choose **Import Mermaid** in the board menu, in the **UML** drawer under **Text to diagram**, or on an empty board.

1. Paste Mermaid text. A flowchart, `classDiagram`, `stateDiagram-v2` or `sequenceDiagram` is supported.
2. Click **Add to board**.

The diagram becomes editable shapes and connectors, placed to the right of existing content. If the text cannot be read, the dialog shows an error and you can fix it.

### Paste text and objects

Pasting plain text on the board creates one text object with your line breaks kept; long text wraps at a set width. Pasting objects copied from another Tabula board (`Ctrl+C`, `Ctrl+V`) places them at your pointer.

## Related

- [Boards and the home screen](boards.md)
- [Version history](version-history.md)
- [Polls](polls.md)
- [Comments](comments.md)
