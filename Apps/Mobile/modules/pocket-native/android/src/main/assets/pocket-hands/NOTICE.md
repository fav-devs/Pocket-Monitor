# Hand and face models (Android)

`hand_landmarker.task` is MediaPipe's hand landmarker bundle (palm detector + hand landmark
model, float16, version 1), `blaze_face_short_range.tflite` is MediaPipe's BlazeFace
short-range face detector (float16, version 1), and `face_landmarker.task` is MediaPipe's face
landmarker bundle (BlazeFace short range + the 478-point face mesh with irises + blendshapes,
float16, version 1). All are Copyright Google LLC and released under
the Apache License 2.0 (the licence text is in
`Apps/Desktop/crates/pm-controller/assets/hand/LICENSE-opencv-zoo-apache-2.0.txt`, the same
Apache 2.0 text). They are the files Google publishes at:

| File | URL | SHA-256 |
| --- | --- | --- |
| `hand_landmarker.task` | https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task | `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1` |
| `blaze_face_short_range.tflite` | https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite | `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f` |
| `face_landmarker.task` | https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task | `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff` |

They run on the phone only, through MediaPipe Tasks (`com.google.mediapipe:tasks-vision`, Apache
2.0). The face detector finds where a face is so the camera can be told to track it; the face
landmarker finds the outline, eyes and mouth of up to three faces in a clip being edited, for the
editor's face retouch (`edit/PocketFaceRetouchEffect.kt`). Neither recognises or identifies
anyone. No picture, landmark or sound leaves the phone, and nothing is stored. iOS uses Apple's
Vision framework instead and ships no model.
