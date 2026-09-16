default:
    @just --list

swift-test:
    swift test

desktop-core:
    ./scripts/desktop-build-swift-core.sh

desktop-build: desktop-core
    cd Apps/Desktop && OPC_CORE_LIB_DIR="$(../../scripts/desktop-build-swift-core.sh)" cargo build --workspace

desktop-test: desktop-core
    cd Apps/Desktop && OPC_CORE_LIB_DIR="$(../../scripts/desktop-build-swift-core.sh)" cargo test --workspace

desktop-check: desktop-core
    cd Apps/Desktop && cargo fmt --all -- --check
    cd Apps/Desktop && OPC_CORE_LIB_DIR="$(../../scripts/desktop-build-swift-core.sh)" cargo clippy --workspace --all-targets -- -D warnings
    cd Apps/Desktop && OPC_CORE_LIB_DIR="$(../../scripts/desktop-build-swift-core.sh)" cargo test --workspace

check: swift-test desktop-check
