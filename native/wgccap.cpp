// wgccap — native Windows Graphics Capture of a single WINDOW (the API OBS uses for Window
// Capture). Captures only the target HWND even when it's behind others, and emits a steady
// 30fps stream of raw BGRA frames to stdout for ffmpeg (-f rawvideo -pix_fmt bgra -s WxH).
//
//   wgccap.exe <hwnd-decimal>
//   stderr on start:  WGC_SIZE w=<W> h=<H>
//
// Build: cl /std:c++17 /EHsc /O2 wgccap.cpp /Fe:wgccap.exe d3d11.lib dxgi.lib windowsapp.lib

#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <stdio.h>
#include <stdlib.h>
#include <io.h>
#include <fcntl.h>
#include <mutex>
#include <vector>

using namespace winrt;
using namespace winrt::Windows::Graphics;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;

static std::mutex g_mtx;
static std::vector<BYTE> g_latest;     // most recent BGRA frame (W*H*4), tightly packed
static int g_w = 0, g_h = 0;

int main(int argc, char** argv) {
    _setmode(_fileno(stdout), _O_BINARY);
    if (argc < 2) { fprintf(stderr, "usage: wgccap <hwnd>\n"); return 1; }
    HWND hwnd = (HWND)(intptr_t)strtoull(argv[1], nullptr, 10);
    if (!IsWindow(hwnd)) { fprintf(stderr, "WGC bad hwnd\n"); return 2; }

    init_apartment(apartment_type::multi_threaded);

    // D3D11 device (BGRA support required for WGC).
    com_ptr<ID3D11Device> d3d;
    com_ptr<ID3D11DeviceContext> ctx;
    if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
            d3d.put(), nullptr, ctx.put()))) { fprintf(stderr, "WGC d3d fail\n"); return 3; }

    com_ptr<IDXGIDevice> dxgi = d3d.as<IDXGIDevice>();
    com_ptr<::IInspectable> inspectable;
    if (FAILED(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(), inspectable.put()))) return 4;
    IDirect3DDevice rtDevice = inspectable.as<IDirect3DDevice>();

    // GraphicsCaptureItem for the window (via the interop factory).
    auto interop = get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    GraphicsCaptureItem item{ nullptr };
    if (FAILED(interop->CreateForWindow(hwnd, guid_of<GraphicsCaptureItem>(), put_abi(item))) || !item) {
        fprintf(stderr, "WGC create-for-window fail\n"); return 5;
    }

    auto isz = item.Size();
    g_w = isz.Width; g_h = isz.Height;
    if (g_w <= 0 || g_h <= 0) { g_w = 1280; g_h = 720; }
    fprintf(stderr, "WGC_SIZE w=%d h=%d\n", g_w, g_h); fflush(stderr);
    g_latest.assign((size_t)g_w * g_h * 4, 0);

    // Fixed-size CPU-readable staging texture; frames are copied here then read out.
    D3D11_TEXTURE2D_DESC sd = {};
    sd.Width = g_w; sd.Height = g_h; sd.MipLevels = 1; sd.ArraySize = 1;
    sd.Format = DXGI_FORMAT_B8G8R8A8_UNORM; sd.SampleDesc.Count = 1;
    sd.Usage = D3D11_USAGE_STAGING; sd.BindFlags = 0;
    sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    com_ptr<ID3D11Texture2D> staging;
    if (FAILED(d3d->CreateTexture2D(&sd, nullptr, staging.put()))) return 6;

    auto pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        rtDevice, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, { g_w, g_h });
    auto session = pool.CreateCaptureSession(item);
    try { session.IsCursorCaptureEnabled(true); } catch (...) {}

    pool.FrameArrived([&](Direct3D11CaptureFramePool const& p, winrt::Windows::Foundation::IInspectable const&) {
        auto frame = p.TryGetNextFrame();
        if (!frame) return;
        auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
        com_ptr<ID3D11Texture2D> src;
        if (FAILED(access->GetInterface(guid_of<ID3D11Texture2D>(), src.put_void()))) return;
        D3D11_TEXTURE2D_DESC fd = {}; src->GetDesc(&fd);
        // Copy the overlapping region into the fixed staging (crop/pad on resize) so the
        // output frame size never changes mid-stream (ffmpeg rawvideo needs a constant size).
        UINT cw = fd.Width < (UINT)g_w ? fd.Width : (UINT)g_w;
        UINT ch = fd.Height < (UINT)g_h ? fd.Height : (UINT)g_h;
        D3D11_BOX box = { 0, 0, 0, cw, ch, 1 };
        ctx->CopySubresourceRegion(staging.get(), 0, 0, 0, 0, src.get(), 0, &box);
        D3D11_MAPPED_SUBRESOURCE map;
        if (SUCCEEDED(ctx->Map(staging.get(), 0, D3D11_MAP_READ, 0, &map))) {
            std::lock_guard<std::mutex> lk(g_mtx);
            const BYTE* s = (const BYTE*)map.pData;
            for (int y = 0; y < g_h; y++)
                memcpy(&g_latest[(size_t)y * g_w * 4], s + (size_t)y * map.RowPitch, (size_t)g_w * 4);
            ctx->Unmap(staging.get(), 0);
        }
    });

    session.StartCapture();

    // Steady 30fps: emit the most-recent frame every ~33ms (duplicate when the window is
    // static — WGC only delivers on change). Gives ffmpeg a constant-rate rawvideo stream.
    std::vector<BYTE> out((size_t)g_w * g_h * 4, 0);
    LARGE_INTEGER freq; QueryPerformanceFrequency(&freq);
    LARGE_INTEGER next; QueryPerformanceCounter(&next);
    const double frameTicks = (double)freq.QuadPart / 30.0;
    for (;;) {
        { std::lock_guard<std::mutex> lk(g_mtx); memcpy(out.data(), g_latest.data(), out.size()); }
        if (fwrite(out.data(), 1, out.size(), stdout) != out.size()) break; // ffmpeg closed
        fflush(stdout);
        next.QuadPart += (LONGLONG)frameTicks;
        LARGE_INTEGER now; QueryPerformanceCounter(&now);
        double ms = (double)(next.QuadPart - now.QuadPart) * 1000.0 / freq.QuadPart;
        if (ms > 0) Sleep((DWORD)ms);
        else { QueryPerformanceCounter(&next); }
    }
    return 0;
}
