# Publishing Shadowing Studio on the Chrome Web Store

A step-by-step walkthrough, from creating the developer account to shipping updates. The text to paste
into each field is in [`LISTING.md`](LISTING.md); this guide tells you when and where.

## What is in the kit

| What | Where | Used in |
| --- | --- | --- |
| Upload package | `release/shadowing-studio-<version>.zip` (made by `npm run package`) | Package |
| Listing text, category, URLs | [`LISTING.md`](LISTING.md) → *Store listing tab* | Store listing |
| Store icon (128×128) | `public/icons/icon128.png` (also inside the zip) | Store listing |
| 4 screenshots (1280×800) | `store/screenshot-1-practice.png` … `screenshot-4-listen-repeat.png` | Store listing |
| Small promo tile (440×280) | `store/promo-small-440x280.png` | Store listing |
| Marquee tile (1400×560, optional) | `store/promo-marquee-1400x560.png` | Store listing |
| Single purpose, permission justifications, data usage | [`LISTING.md`](LISTING.md) → *Privacy practices tab* | Privacy |
| Privacy policy | [`PRIVACY.md`](../PRIVACY.md), public at `https://github.com/fabrizio-cau/shadowing-studio/blob/main/PRIVACY.md` | Privacy |
| Reviewer notes | [`LISTING.md`](LISTING.md) → *Test instructions tab* | Test instructions |

To regenerate the graphics after a UI change: `npm run build`, then `npm run store-assets`.

---

## 1. Create the developer account (once)

1. **Pick the Google account.** The developer email cannot be changed later, so consider a dedicated
   account for publishing. Store notices (reviews, policy warnings) go to it, so check it regularly.
2. **Turn on 2-Step Verification** for that Google account (myaccount.google.com → Security). The
   Chrome Web Store requires it before you can publish.
3. Open the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) with that account.
4. **Accept the developer agreement** and **pay the one-time registration fee** (US$5, by card).
   You pay it once per account, not per extension.
5. Open **Account** in the dashboard and fill in:
   - **Publisher name**: shown as "Offered by" on the listing. Your name, or a project name.
   - **Contact email**: enter it and click the verification link Google emails you. Publishing is
     blocked until it is verified.
   - **Trader / non-trader declaration** (EU Digital Services Act): for a free, non-commercial personal
     project choose **non-trader**. If you declare yourself a trader, your address, phone number and
     email are shown publicly to EU users.
   - Physical address: only needed for items that sell something. Leave it empty.

## 2. Build the package

```bash
npm test
```

```bash
npm run test:e2e
```

```bash
npm run package
```

This writes `release/shadowing-studio-1.0.0.zip` (about 100 KB): a minified production build with
`manifest.json` at the root of the zip, no source maps and no remote code.

## 3. Pre-flight checks

- [ ] Unzip the package into an empty folder and load *that* folder in `chrome://extensions` →
      *Load unpacked*, so you test the exact build you upload. Then remove it again.
- [ ] Run the manual checklist in the README with it: the real side panel, Chrome's microphone
      prompt, a real microphone with headphones, a video with ads.
- [ ] The GitHub repository is **public**, so the privacy policy and support links open for reviewers
      (checked: both open).
- [ ] The `version` in `public/manifest.json` is higher than any version uploaded before (first upload:
      `1.0.0`).

## 4. Upload

Dashboard → **Items** → **New item** → drop `release/shadowing-studio-1.0.0.zip`.

The dashboard reads the name, summary, icon and permissions from the manifest and opens the item's draft.
The draft has these tabs on the left: **Package**, **Store listing**, **Privacy**, **Distribution**,
**Test instructions**. Fill them in the order below; each saves as a draft (**Save draft**).

## 5. Store listing tab

Copy from [`LISTING.md`](LISTING.md) → *Store listing tab*:

1. **Description**: paste the block as is (plain text; the store keeps the line breaks).
2. **Category**: *Education*. **Language**: *English*.
3. **Store icon**: `public/icons/icon128.png`.
4. **Screenshots**: upload the four `store/screenshot-*.png` in order 1 → 4.
5. **Small promo tile**: `store/promo-small-440x280.png`. It is optional, but listings without it are
   shown after those that have one, so upload it.
6. **Marquee promo tile**: `store/promo-marquee-1400x560.png` (only used if Google features the item).
7. **Homepage URL** and **Support URL**: from `LISTING.md`. Leave *Official URL* and *YouTube video* empty.
8. **Mature content**: off.

## 6. Privacy tab

Copy from [`LISTING.md`](LISTING.md) → *Privacy practices tab*:

1. **Single purpose description**.
2. **Permission justification** for each permission listed (`sidePanel`, `storage`, `downloads`,
   `unlimitedStorage`, host permission). Every field must be filled in or submission is blocked.
3. **Remote code**: *No, I am not using remote code*.
4. **Data usage**: tick according to the definition the dashboard shows (see `LISTING.md`), then tick
   the three certifications.
5. **Privacy policy URL**: the `PRIVACY.md` link.

## 7. Distribution tab

- **Payments**: free.
- **Visibility**: **Unlisted** for the first release. Only people with the link can install it, so you
  can try the store version yourself and with a few learners. Switch to **Public** when you are happy.
- **Regions**: all regions.

## 8. Test instructions tab

Paste the reviewer notes from `LISTING.md`. They explain that no login is needed and how to reach the
microphone feature, which avoids a rejection for "could not test the functionality".

## 9. Submit for review

1. Click **Submit for review**. The dialog offers to **publish automatically** after approval. Untick it
   if you prefer to press *Publish* yourself once it is approved (you then have 30 days to do it).
2. Status becomes *Pending review*. A first submission usually takes a few days, sometimes up to a few
   weeks. Extensions with host permissions on a popular site (like youtube.com) can get a closer look.
3. You get an email when the review finishes.

**If it is rejected**, the email names the policy and a violation code. Common ones:

| Code | Meaning | What to do |
| --- | --- | --- |
| Purple Potassium | A permission is judged unnecessary | Explain the use more concretely in its justification, or remove the permission and resubmit |
| Yellow Zinc | Missing or unclear listing information | Check that the description, screenshots and icon are all there and match what the extension does |
| Yellow Argon | Keyword spam in the description | Shorten repeated keywords (e.g. "YouTube") |
| Blue Argon | Remote code (Manifest V3) | Should not occur: all code is bundled. Reply to the email pointing out there are no remote scripts |

Fix the issue, upload a new zip if code changed (with a higher version), and submit again. You can also
appeal from the link in the email if you think the decision is wrong.

## 10. After approval

- The listing is live at `https://chromewebstore.google.com/detail/<item-id>`, where the item ID is
  shown on the dashboard. Put the link in the README and the GitHub repository description.
- **Your own practice data**: the store version has a different extension ID from the unpacked one,
  so it starts with an empty library. Export recordings from the unpacked version first if you want to
  keep them, then remove the unpacked version so you do not run both on YouTube.
- When you are ready, change **Visibility** to **Public** on the Distribution tab and submit.
- Watch the developer email and the item's **Ratings and reviews** / support tab for user reports.

## 11. Shipping updates

1. Make the change, then raise `version` in `public/manifest.json` (`1.0.0` → `1.0.1` for fixes,
   `1.1.0` for features). The store rejects a package whose version is not higher than the last one.
2. `npm test`, `npm run test:e2e`, and `npm run store-assets` if the UI changed.
3. `npm run package`.
4. Dashboard → the item → **Package** → **Upload new package**. Update the screenshots and text if they
   changed, then **Submit for review**.
5. Users get the update automatically within a few hours of publishing.

Adding a permission or host in an update makes Chrome disable the extension for existing users until
they accept the new permission, so avoid that unless it is necessary.
