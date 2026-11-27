# Hand tracking models

`palm_detection.onnx` and `hand_landmarks.onnx` are the MediaPipe palm detector and hand
landmark models as converted to ONNX by the OpenCV Zoo
(https://github.com/opencv/opencv_zoo, models `palm_detection_mediapipe` and
`handpose_estimation_mediapipe`, 2023feb). MediaPipe is Copyright Google LLC. Both are
released under the Apache License 2.0; the licence text is in
`LICENSE-opencv-zoo-apache-2.0.txt`.

`anchors.bin` is the palm detector's fixed SSD anchor table (2016 centres, little-endian
f32 pairs), taken from the OpenCV Zoo's `mp_palmdet.py`.

The models run on the PC only. Nothing is sent anywhere.

`face_detection_yunet.onnx` is the YuNet face detector (`face_detection_yunet_2023mar`) from
the OpenCV Zoo, by Shiqi Yu, under the MIT licence (`LICENSE-yunet-mit.txt`). It finds where
a face is in the picture so the camera can be told to track it; it does not recognise or
identify anyone, and nothing is stored or sent.
