
# JLC's X's Grok Archiver

## What is it?

It's an archiver for [X's Grok](https://x.com/i/grok) AI generated images generated through its chat interface on the X website.

> I am in no way affiliated with the people behind the X website (or the Grok AI) by the way! I am just a hobby programmer doing this work for free in my spare time!

## How does it work?

It works by intercepting the communication between the browser (which MUST be [Chromium based](https://www.google.com/search?q=chromium+based+browsers)) and the X website to fetch the images and any related details.

It will fetch any new images you generate while the archiver is running and any images found in the chat history.

## Why doesn't it work?

It you experience any bugs or it not working properly on your operating system this is because I am just one person developing this software and I have only tested it on my Linux PC. 

I'll happily fix any bugs encountered, just create a new "issue" in the GitHub repository and document it there (and I'll probably figure out how to fix it soon).

## How to run it?

You can run it using the [Node.js](https://nodejs.org/) package manager ([NPM](https://www.npmjs.com/)). To install NPM you'll have to install Node.js if you haven't done so already.

Then you should be able to run the archiver (in the current working directory) by typing:
```sh
npx grok-archiver
```
Which will try to setup the archive in the directory where you ran the command, if no "grok-archiver.json" file was there already it will first create one and exit.

The "grok-archiver.json" file it created looks something like this:
```json
{
  "chromiumPath": "google-chrome",
  "archivePath": "the/absolute/path/to/the/directory"
}
```
On my Linux system "google-chrome" is the command which will launch my compatible browser. If you use macOS or Windows it will try to detect the path to Chrome. But please check that it got it right or manually enter the path  to a Chromium based browser.

I suspect these values will work (if you use Chrome):
| System | Path |
| --- | --- |
| macOS | ~/Library/Application Support/Google/Chrome |
| Windows | C:\Program Files\Google\Chrome\Application\chrome.exe

## Why must the browser be Chromium based?

This is because my archiver is using the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) to do its magic. This allows my program to easily intercept communication with their website.

## What's the structure of the archive?

In the archive directory two directories will be created, which are named "database" and "images".

### The images directory:

The "images" directory is where every image will be downloaded to. And they will be archived in subdirectories matching the creation date of the image.

The filenames will be formatted like this: 
```
imageId-beginning_of_prompt.jpg
```

So a full path to an image could look like this:
```
archive_dir/2023/11/06/1826923980957102080-Photo-of-a-man….jpg
```

Any truncated prompt is followed by … ([U+2026](https://en.wikipedia.org/wiki/Ellipsis)) to make it clear that it was truncated. This is done to avoid file-system errors due to too long filenames.

### The database directory:

The "database" directory is where records are kept for every image which has been archived. This system allows you to delete or rename the downloaded images while still keeping a record to avoid them being re-downloaded.

Also more details about the images are stored in those records.

Looking up details for a specific image in the database is very easy to do using the search function in your file explorer. Just copy the "imageId" part of the image and search the database directory for the record (which is a .json file).

## How do I support you?

I am at the moment chronically sick, without a job, with tons of debt, two kids and a wife (which I can't support economically). So please [sponsor my efforts](https://github.com/sponsors/JoakimCh) to develop and maintain a working solution like this, I would really appreciate it if you did! ❤️

## The end (of the readme).

If you want to get in touch you can find me on X as [HolyGodCow](https://twitter.com/HolyGodCow).
