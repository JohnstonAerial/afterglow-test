# Afterglow

**Sunrise and sunset sky-quality forecasts, built for photographers and drone pilots.**

🔗 [afterglow.johnstonaerial.com](https://afterglow.johnstonaerial.com)

Afterglow predicts how good a sunrise or sunset is actually going to look — not just whether the sun is up, but whether the sky will put on a show. Built for planning drone shoots, timelapses, and just knowing when to grab a camera.

☕ **Free to use.** If it helped you catch an epic shot — sunrise, sunset, or a moon timelapse — you can [buy me a coffee](https://buymeacoffee.com/JohnstonAerial).

## What's new in 2.0

Afterglow 2.0 is a big redesign of the Plan tab, with a few new tools.

- **Plan tab, rebuilt.** A time bar that stays at the top, a clear "Planning from" place, a **Subject** and **Your spot** you place on the map, a sky view, and less clutter. Rarely used tools are folded away until you need them.
- **Calendar, your way.** Add a shoot to your calendar at sunrise or sunset, or choose **Custom**: start 2 hours before sunset, 30 minutes before moonrise, at a clock time, or at the time on the bar, for as long as you like.
- **Alerts with a minimum forecast.** Sunrise and sunset alerts can wait until the forecast is Good, Great or Epic, and tell you the score. Poor skies stay quiet.
- **My location**, everywhere. One button in the place pickers, and your saved place only changes when you tap it.
- **Larger text** with the **Aa** button.
- **Easier Today and Outlook.** Day arrows on Today, past times dimmed on Outlook, and tap a day to open it.
- **Kinder to computers.** Scrolling over the map scrolls the page. Zoom with +/−, or ⌘/Ctrl + scroll.
- **Fixes.** Location works on Chrome for Mac, and the Plan sky forecast no longer gets stuck on "Reading the sky…".

## Features

- **Sky quality scoring** — a heuristic model based on published sunset-photography guidance: mid/high cloud in the right range catches color, low cloud blocks it, haze flattens it. Scores are checked against real shoots and still being refined. Like any forecast, it can miss, especially on high cloud.
- **Golden & blue hour, precisely** — computed from actual solar angle (civil twilight math), not flat clock-time offsets. Nautical and astronomical twilight times shown when they fall that day.
- **Outlook** — the coming sunrises and sunsets, each scored, with past times dimmed.
- **Any location** — search by city, state or ZIP, or use your current position, and switch any time with the location button. Your chosen location stays on your device.
- **Moon conditions** — phase, illumination, moonrise/moonset with compass headings, and a callout for the "big warm moon on the horizon" alignment window. Includes an hourly timelapse-conditions score.
- **Plan tab** — Sun and Moon direction and height at any time, on any date, anywhere, on a free, keyless Leaflet/OpenStreetMap map. Place a subject, find the dates the Sun or Moon lines up with it, allow for height and obstructions, share a link, add the shoot to your calendar, or print a shoot card.
- **Three tabs** — Today, Outlook and Plan.
- **Installable app (PWA)** — add it to your Home Screen on iOS or Android for a real standalone app experience, with offline support for the app itself (forecast data always pulls fresh, never stale).
- **Push notifications** — optional alerts before sunrise, sunset, or golden hour (morning and evening), sent right to your phone. You choose which alerts you want and how far ahead: 15, 30, 60 or 90 minutes, and sunrise and sunset alerts can wait for a minimum forecast (Good or better, Great or better, or Epic only). Notifications need the app installed (Home Screen on a phone or tablet, Dock or app window on a computer) (see the [how-to](HOW-TO.md)).
- **Built-in resilience** — automatic retry with backoff, cached last-known data with a clear "stale" indicator, and plain-language error messages instead of raw failures.

## How it works

- New to Afterglow? The [how-to guide](HOW-TO.md) covers installing, notifications and reading the score.

- Forecast data comes from [Open-Meteo](https://open-meteo.com/) — free, no API key required.
- Moon phase, moonrise and moonset are calculated on your device with [Astronomy Engine](https://github.com/cosinekitty/astronomy) (MIT licence, by Don Cross). Nothing about your location is sent anywhere for this, and it works offline. Checked against the US Naval Observatory, rise and set times agree to within a minute.
- Cloud cover is sampled along the sun's actual azimuth (not just overhead) using great-circle geometry, to judge whether direct light can actually reach the horizon.
- Notifications run on a Cloudflare Worker with a scheduled check every 5 minutes, using Web Push — no app store, no third-party notification service.

## Good to know

- Weather models update a few times a day, so a forecast can change when a new run arrives. Check again closer to the time, especially for sunsets more than a day out.
- Color often peaks a little after sunset (15–20 minutes) or just before sunrise, so Afterglow shows that window on the main card for Fair and better days.
- Scores run from Flat to Fair, Good, Great and Epic. Treat them as a guide to the odds, not a promise.

## Tech

Single-file HTML/CSS/JS front end, no build step. Notification backend is a standalone Cloudflare Worker (`worker.js`) using only the Web Crypto API — no external push libraries. Visits are counted with [Cloudflare Web Analytics](https://www.cloudflare.com/web-analytics/).

## Status

Actively used and evolving. Scoring constants (cloud sweet-spot ranges, murk-penalty thresholds, sampling distance) are being refined against real shoot outcomes over time.

## Privacy

Afterglow has no accounts and no ads. Your chosen location stays on your device, except when you turn on notifications: then that location, your alert choices and your phone's push address are stored so the alerts can be sent, and they're removed when you turn notifications off. The page also uses Cloudflare Web Analytics, a privacy-focused visit counter. It counts visits and rough details like country and device type, with no cookies and no personal information, so I can see whether Afterglow is being used.

## Support this project

Afterglow is free. If it's saved you time, or helped you catch an epic sunset, sunrise, or moon shot you'd have otherwise missed, you can [buy me a coffee ☕](https://buymeacoffee.com/JohnstonAerial). It helps cover the time I put into keeping it accurate.

Thank you, and good light.
— Jim, Johnston Aerial
---

Built by [Johnston Aerial](https://johnstonaerial.com).
