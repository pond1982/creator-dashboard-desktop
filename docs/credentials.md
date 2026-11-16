# Connect your accounts

Install and open **Argus Pip** on the Mac or Windows PC where you want to see your reports. In the first-use screen, select **YouTube**, **App Store Connect**, or **Both sources** and choose **Continue to connections**. Complete just the sections for your selected sources. **Settings** lets you change that choice later. [Download and install](../README.md#download-and-install)

| What you want | What to set up |
| --- | --- |
| Public YouTube statistics | [One Google API key and your channel list](#public-youtube-statistics) |
| Private YouTube Studio reports | [One desktop OAuth client and consent for each channel](#private-youtube-studio-reports) in addition to the public connection |
| App Store sales | [One Apple team reporting key and the vendor number](#app-store-connect-sales) |

## Public YouTube statistics

One API key covers all your selected channels, including channels that different Google accounts own.

1. Sign in to Google Cloud. Open the **project selector** in the top bar. Choose an existing project, or select **New project**, enter a name such as “Argus Pip,” click **Create**, and select the new project. [Google Cloud Console](https://console.cloud.google.com/)
2. In **APIs & Services → Library**, open **YouTube Data API v3** and click **Enable**. [YouTube Data API v3 library](https://console.cloud.google.com/apis/library/youtube.googleapis.com)
3. In **APIs & Services → Credentials**, click **Create credentials → API key**. Name the key for this dashboard if prompted, create it, and copy the key value. [Open Credentials](https://console.cloud.google.com/apis/credentials)
4. Open the new key. Under **API restrictions**, select **Restrict key**, choose **YouTube Data API v3**, and save. The app’s background process sends the requests. For a home connection with a changing public IP address, leave **Application restrictions** at **None**. If you have a fixed public outbound IP address, you can restrict the key to that address. A website/referrer restriction will reject the background requests. [Google’s key restriction guide](https://docs.cloud.google.com/docs/authentication/api-keys)
5. In **Connections → YouTube**, paste the key. Enter the first channel’s public `@handle`, channel ID starting with `UC`, or channel URL containing one of those. Use **Add channel** for each additional channel. Copy the channel’s page address when using a URL.
6. Click **Connect channels**, open the **YouTube** tab and select a channel by name. The dashboard shows the latest public release, lifetime statistics, and recent videos with their publish dates, durations, views, likes, and comments. YouTube rounds subscriber counts down to three significant figures. [Channel statistics](https://developers.google.com/youtube/data/reference/rest/v3/channels#statistics)

To edit the list, return to **Connections → YouTube**, change the rows, and save. Leave the API key field blank to reuse the saved key. **Settings → Visible channels** lets you choose which tabs appear. Hidden channels continue to refresh while the YouTube source is enabled.

## Private YouTube Studio reports

This optional connection lets you see watch time, average view duration, subscribers gained and lost, daily activity, traffic sources, and viewer countries. The displayed 28-day window ends on the latest available reporting day. Small or recent channels may have limited breakdowns. [YouTube Analytics report availability](https://developers.google.com/youtube/analytics/reference/reports/query#endDate)

### Create the desktop client once

1. Select the project you used for the YouTube API key. Under **APIs & Services → Library**, open **YouTube Analytics API** and click **Enable**. Keep **YouTube Data API v3** enabled too. [YouTube Analytics API library](https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com)
2. Open **Google Auth Platform → Branding**. If the platform is new, click **Get started**. Enter “Argus Pip” as the app name and choose your **User support email**. Click **Next**. For personal Google accounts, select **External** under **Audience**. Enter your contact email, review the policy, and finish with **Create**. If the platform is already configured, open its **Branding** and **Audience** pages to review those settings. [Google’s consent setup](https://developers.google.com/workspace/guides/configure-oauth-consent)
3. For an external project in **Testing**, open **Audience → Test users → Add users**. Enter each channel owner’s Google sign-in email and click **Save**. One email is sufficient for the Brand Account channels owned through that login. [Open the audience settings](https://console.cloud.google.com/auth/audience)
4. Open **Data Access → Add or remove scopes**. Find or enter the two scopes below. Click **Update**, then **Save**. The first permission identifies the selected channel. The second reads its non-monetary analytics. [Google’s scope descriptions](https://developers.google.com/identity/protocols/oauth2/scopes)

   ```text
   https://www.googleapis.com/auth/youtube.readonly
   https://www.googleapis.com/auth/yt-analytics.readonly
   ```

5. Open **Clients → Create client**. Set **Application type** to **Desktop app**, enter a name such as “Argus Pip desktop,” and click **Create**. In the creation dialog, choose **Download JSON**. Save that file on the computer running the dashboard. Desktop clients support the loopback callback automatically. [Open Google Auth Platform clients](https://console.cloud.google.com/auth/clients) · [Google’s desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app)
6. In the desktop app, open **Connections → YouTube → Studio analytics**. Select the downloaded file in **Desktop OAuth client JSON** and click **Save Google client**. Use the local file picker for this credential.

### Authorize each channel

1. Open the **YouTube** tab, select the channel by name, and click **Connect Studio analytics**. Keep the dashboard running throughout sign-in.
2. In Google’s browser prompt, select the owner’s Google account. If Google offers several YouTube identities, pick the channel or Brand Account matching the dashboard tab. Review and grant both read-only permissions. Your Google password goes to Google’s sign-in page. [YouTube’s Brand Account guidance](https://support.google.com/youtube/answer/3046478)
3. Google returns your browser to a temporary address on your own computer. When the browser confirms the connection, switch back to the desktop app. The dashboard checks the authorized channel ID and saves the refresh token using your operating system’s credential protection. If a different identity was selected, restart consent from the intended channel’s tab.
4. Repeat for each channel whose private reports you want. The same desktop client serves them all.

**Seven-day reauthorization in Testing.** For an external app in **Testing**, authorization for these scopes expires seven days after the user grants consent. Reconnect the channel when prompted. For ongoing personal use, open **Google Auth Platform → Audience → Publishing status → Publish app**, confirm **In production**, then reconnect each channel. This removes the seven-day testing limit. Google documents a personal-use verification exception for apps with fewer than 100 users. Your own project can still display an unverified-app notice. [Google’s publishing settings](https://support.google.com/cloud/answer/15549945) · [Personal-use verification exception](https://support.google.com/cloud/answer/13464323)

## App Store Connect sales

You need an App Store Connect team API key with the **Sales and Reports** role, its two identifiers, and your vendor number. One connection covers the apps present in that vendor’s sales reports.

1. Sign in to **App Store Connect → Users and Access → Integrations**. Select **App Store Connect API → Team Keys**. If **Request Access** appears, the **Account Holder** must submit the request and wait for Apple to enable access. [Open App Store Connect integrations](https://appstoreconnect.apple.com/access/integrations/api)
2. As the **Account Holder** or an **Admin**, click **Generate API Key** or **+**. Name it “Argus Pip,” choose **Sales and Reports** under **Access**, then click **Generate**. Sales reports require a team key. [Apple’s team key instructions](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/) · [Reporting roles](https://developer.apple.com/documentation/appstoreconnectapi/downloading-analytics-reports)
3. Copy the **Issuer ID** from the team keys page and the **Key ID** from the key’s row. Download the private `.p8` file next to that key and keep it in a safe place. Apple makes the file available to download once. [Download and store a team key](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)
4. Open **Reports** in App Store Connect to reach **Payments and Financial Reports**. Copy the **Vendor Number** beneath your legal entity name at the upper left. If you have multiple vendors, choose the one whose apps you want to see. [Find your vendor number](https://developer.apple.com/help/app-store-connect/getting-paid/view-payments-and-proceeds/)
5. Open **Connections → App Store Connect** in the app. Paste the **Key ID**, **Issuer ID**, and **Vendor number**, choose the matching `.p8` file, then click **Connect app sales**. The app signs its requests locally and downloads the initial seven-day view and its comparison.

Select **1 day**, **7 days**, **30 days**, or **90 days**. Each period is compared with the immediately preceding period using Pacific reporting dates. Paid downloads and paid in-app purchases include refunds. Free first-time downloads have their own column. Proceeds are estimates in the reported currency. An explicit no-sales day counts as covered. If some reports are unavailable, the dashboard shows coverage and withholds changes until both periods are complete. [Apple’s sales report fields](https://developer.apple.com/help/app-store-connect/reference/reporting/summary-sales-report/) · [Reporting schedule](https://developer.apple.com/help/app-store-connect/reference/reporting/sales-and-trends-reports-availability/)

## Troubleshooting

| What you see | What to check |
| --- | --- |
| I closed the window and cannot find it | Look for the app icon in the Mac menu bar or the Windows notification area (including hidden icons). Choose **Open Argus Pip**, or open the app again from Applications or Start. |
| Public YouTube counts fail with a key or quota error | Check that the key’s project has YouTube Data API v3 enabled, the API restriction includes it, and the application restriction permits server requests from this computer. Check the project’s quota if Google reports it has been exhausted. |
| Google blocks Studio consent or reports a mismatched channel | Confirm **Desktop app**, both enabled APIs, both read-only scopes, and the test-user email if in Testing. Retry in the browser on the same computer with the matching channel identity. |
| An Apple request returns 401 or 403 | Match the **Issuer ID**, **Key ID**, and `.p8` from the same active team key. Check its **Sales and Reports** access and pending agreements in App Store Connect. |
| An Apple period has gaps | Check the vendor number and the dates. The previous day generally becomes available by 8 a.m. Pacific. Refresh the range to retry missing days or resume a large backfill. |
| The dashboard cannot read a saved credential | Sign in to the same OS user account that saved the connection. On Mac, unlock the login Keychain if prompted. If an item was deleted or revoked, open **Connections** to replace it, or reconnect Studio on the channel’s page. |
| PDF export fails | Choose a writable destination with free disk space and retry **Export PDF**. The desktop app includes its PDF renderer. |

## Pause updates, revoke access, or remove local data

**To pause**, disable a source in **Settings**, or choose **Quit Argus Pip** from the app icon in the Mac menu bar or Windows notification area. To control startup, use **Launch at login** in the same menu. Your local reports and connections are retained.

**To revoke provider access**, use the account that issued or authorized the credential.

- **Public YouTube API key.** In **APIs & Services → Credentials**, select the dashboard’s API key and delete it when you want to retire that key. If another application also uses it, replacing it there first prevents an interruption. [Manage Google API keys](https://docs.cloud.google.com/docs/authentication/api-keys)
- **Studio permission.** In the Google account that authorized the channel, select your dashboard project under **Third-party connections**, choose **See details → Remove access**, and confirm. Repeat for other authorizing accounts as needed. [Manage Google connections](https://myaccount.google.com/connections)
- **Apple team key.** In **Users and Access → Integrations → App Store Connect API → Team Keys**, open the active key’s actions and revoke the specific key used for this dashboard. Revocation applies wherever that key was used. [Apple’s key management instructions](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/#manage-individual-and-team-keys)

**To reset the desktop app**, first clear **Launch at login** if enabled and choose **Quit Argus Pip**. Open the following folder for your operating system. Argus Pip keeps the original desktop folder name so it can read existing setups.

| System | Where to look |
| --- | --- |
| macOS | In Finder choose **Go → Go to Folder**, paste `~/Library/Application Support/Creator Dashboard Desktop/` and press Return. |
| Windows | Press **Windows key + R**, paste `%APPDATA%\Creator Dashboard Desktop\` and press Enter. |

The `dashboard` folder contains your report snapshots, preferences and encrypted credentials. Moving that folder to the Trash or Recycle Bin resets the desktop setup on its next launch. On Mac, also move `widget-snapshot.json` from the same parent folder to the Trash to clear the widget’s saved summary. Remove the widget from your desktop or Notification Center to clear it from view immediately. Emptying the bin removes the local copy. Revoke provider access separately using the steps above. PDFs and original credential files you saved elsewhere stay in their chosen locations.

**Original Mac browser service.** Its reports live separately in `~/Library/Application Support/CreatorDashboard/` and its keys use the exact Keychain service name `local.creator-dashboard`. If retiring that installation, run `npm stop` in its project folder. To remove its local data, move that specific folder to the Trash and remove its matching entries from the login keychain in **Keychain Access**.
