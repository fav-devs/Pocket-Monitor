/**
 * In-app legal pages (OpenPocketCine `LegalScreens`). Privacy and terms are this app's own text;
 * licenses and NOTICE follow the repository's LICENSE and NOTICE.
 */
import { appBrand } from '@/features/startup/brand';

export type LegalPage = 'privacy' | 'terms' | 'licenses' | 'notice';

export const legalTitles: Record<LegalPage, string> = {
  privacy: 'Privacy',
  terms: 'Terms of Use',
  licenses: 'Licenses',
  notice: 'NOTICE',
};

const app = appBrand.name;

const privacy = `${app} talks to your Osmo camera over Bluetooth and the camera's own Wi-Fi. The app has no account and runs no cloud.

What stays on this phone
• Saved camera names, models and the network each one uses. Camera and network Wi-Fi passwords are kept in the phone's secure storage only.
• Operator preferences such as Keep screen awake, joystick feel and View Assist choices.
• Diagnostics: recent connection events, kept in memory while the app runs.

What never leaves the phone
• Live video, camera telemetry and pairing traffic stay on the local link between this phone and the camera.

Reports you choose to send
Report a problem and Share Diagnostics build a plain-text report on this phone and hand it to the share sheet. Nothing is uploaded by the app itself; you choose where the report goes. Reports contain app and device versions, the connection state and recent connection events. They do not include footage, screenshots, GPS location, camera Wi-Fi names or passwords. Do not include passwords or other sensitive information in your message.

Third parties
• Apple or Google may process permission prompts and OS diagnostics under their own policies.
• Saving a clip or using the share sheet is something you start. The app you pick then handles that file.

Privacy questions: ${appBrand.supportUrl}.`;

const terms = `${app} is free software under the Apache License 2.0. You may use, modify, and share it under that license.

This is an unofficial field monitor. It is not affiliated with, endorsed by, or supported by DJI. "DJI", "Osmo", "Osmo Pocket", and "Mimo" are trademarks of SZ DJI Technology Co., Ltd., used only to identify the cameras the app can talk to.

Reverse-engineered protocol behavior can be incomplete or wrong. Do not rely on this app as the only way to start or stop a take. Record from the camera body until those commands are proven.

The software is provided on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND. See LICENSE in the repository.

By using the app you agree to follow the Code of Conduct when participating in the project.`;

const licenses = `${app}
Copyright 2026 Erik Sutton and OpenPocketCine contributors
Licensed under the Apache License, Version 2.0 (the "License"). You may not use this software except in compliance with the License. You may obtain a copy of the License at https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.

SN Pro typeface
Copyright 2024 The SN Pro Project Authors (https://github.com/supernotes/sn-pro), bundled through @expo-google-fonts/sn-pro
Licensed under the SIL Open Font License, Version 1.1 (https://openfontlicense.org). The font may be used, studied, modified and redistributed freely as long as it is not sold by itself. Modified versions may not use the Reserved Font Names.

Sora typeface
Copyright 2019 The Sora Project Authors (https://github.com/sora-xor/sora-font)
Licensed under the SIL Open Font License, Version 1.1 (https://openfontlicense.org). The font may be used, studied, modified and redistributed freely as long as it is not sold by itself. Modified versions may not use the Reserved Font Names.

Hugeicons free icons
Copyright Hugeicons (https://hugeicons.com), from @hugeicons/core-free-icons, drawn with @hugeicons/react-native (Copyright 2025 Hugeicons)
Licensed under the MIT License. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

React Native, Expo and the other open-source libraries in this app are used under their own licenses (MIT unless stated otherwise in each package).`;

const notice = `OpenPocketCine
Copyright 2026 Erik Sutton and OpenPocketCine contributors

${app} includes code adapted from OpenPocketCine (Apache License 2.0).

This product is licensed under the Apache License, Version 2.0 (see LICENSE).
Third-party software distributed with this product is listed in THIRD-PARTY-NOTICES.md.

Bundled UI typefaces (SIL Open Font License 1.1):
- SN Pro, Copyright 2024 The SN Pro Project Authors (https://github.com/supernotes/sn-pro)
- Sora, Copyright 2019 The Sora Project Authors (https://github.com/sora-xor/sora-font)

Bundled UI icons from Hugeicons (MIT):
- Hugeicons free icons, Copyright Hugeicons (https://hugeicons.com)

This project is not affiliated with or endorsed by SZ DJI Technology Co., Ltd.
"DJI", "Osmo", "Osmo Pocket", and "Mimo" are trademarks of SZ DJI Technology Co., Ltd., used for identification only.
No DJI SDK or proprietary DJI documentation is included in, distributed with, or required by this project.`;

export const legalDocuments: Record<LegalPage, string> = { privacy, terms, licenses, notice };
