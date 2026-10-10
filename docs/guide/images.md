# Images

You can put pictures on a board: a screenshot, a photo of a whiteboard, a logo or a diagram. A picture is an object like any other. You can move it, resize it, put it in a frame and comment on it.

## Add a picture

There are three ways. They all work with several files at once, up to 10 at a time.

- **Paste.** Copy a picture or a screenshot, then press `Ctrl+V` (`Cmd+V` on Mac) with the board in front. The picture lands in the middle of your view.
- **Drop.** Drag one or more files from your computer onto the board. They land where you drop them.
- **Image button.** Choose **Image** in the left toolbar, below **Frame**, and pick files. If your server does not store images, the button is not there.

PNG, JPEG, GIF, WebP and SVG files work. Anything else, such as a HEIC photo from a phone, is refused with a message that names the file. The other files you added at the same time still go in.

The new pictures are selected. Several pictures appear side by side, one row after another, and one `Ctrl+Z` takes them all away again.

> Only people who can edit the board can add pictures. Everyone who can open the board can see them.

## What happens to the file

Tabula prepares the picture in your browser before it is sent:

- A picture larger than 2560 pixels on its longest side is scaled down. The board shows it at a sensible size, no more than about 60% of your view, and you can scale it up again.
- Location and camera information in a photo (the part of the file that can hold GPS coordinates) is removed, and the picture is turned the right way up.
- An SVG file becomes an ordinary PNG picture, so it looks the same everywhere.
- An animated GIF is left as it is. It has to be under 10 MB and no more than 2560 pixels wide or high, or it is refused.
- A file larger than 10 MB after this is refused. A board also has room for a limited amount of pictures. When it is full you see "This board has used its image storage". Remove pictures you no longer need, or ask your administrator.

## Work with a picture

Select a picture to move, rotate, lock, duplicate or delete it, or to put it in a frame. Drag a corner to resize it: the proportions stay the same. A picture can have connectors and comments like a shape.

The quick-action bar has two buttons that belong to pictures:

- **100%** sets the picture back to its natural size, around its centre.
- **Alt text** opens a field where you describe the picture in a sentence. Screen readers use it, and so do AI tools that read the board.

<!-- screenshot: the quick-action bar above a selected picture, with 100% and Alt text -->

## When a picture is not there yet

A picture is stored on your device first and sent to the server in the background. It shows at once for you. If you are offline, or the server is slow, other people see a grey box that says "Image not uploaded yet" until it arrives. It is sent when the connection is back, and nothing else for you to do.

If the copy kept on your device is gone, or the server refused the upload, the picture is not dropped. You get a notice ("An image could not be uploaded because this browser no longer has it. Add it again."), and the box reads "Not uploaded: add this image again". A refused upload is tried once more each time the board is opened.

On a hosted workspace a picture over 1 MB cannot be uploaded for now. You see "This image is over 1 MB, which is the upload limit for now. Use a smaller image." and the box reads "Not uploaded: over 1 MB". If you drop several at once, the notice counts them ("2 images are over 1 MB and may not upload to this workspace yet. Use smaller images."). Tabula aims to send pictures of about 900 KB, so most photos are shrunk to fit.

A grey box can also say:

| Message | What it means |
|---|---|
| Loading | The picture is on its way. |
| Offline | Your device cannot reach the server and has no copy. It tries again when you are back online. |
| No access to this image | You no longer have access to this board. |
| Image not found | The server does not have the file. |

## Pictures in exports and templates

- **PNG image** and **SVG vector** exports include the pictures.
- **Board file (.drift)** keeps the pictures inside the file. Opening it as a new board, or with **Import a board file into this board**, brings them back and sends them to the board in the background. A picture that cannot be read from the file (a type Tabula does not support, or a file that is too large) shows as a placeholder, and the rest of the board opens as usual.
- **JSON snapshot** names the pictures but does not hold them. The file says so. Use a `.drift` file to keep them.
- **Markdown summary** lists a picture inside a frame as `Image: ` followed by its alt text, or `Image (image/png, 640 x 480)` when it has none.
- When you save a board or a selection as a template, pictures are left out. The save dialog says how many. Templates cannot hold pictures yet.

## Deleting a picture

Deleting a picture takes it off the board, but not out of the board's history. Older versions in [Version history](version-history.md) still show it, and restoring one brings it back. Tabula keeps the file for as long as any kept version or the board itself refers to it, and removes it automatically some days after the last one stops. Until then, anyone who can open the board can still see it in those versions.

If a picture must be gone for good, delete it from the board and then delete the versions that show it.

## Related

- [Shapes, text and sticky notes](shapes-text-notes.md)
- [Export and import](export-import.md)
- [Sharing, roles and teams](sharing.md)
