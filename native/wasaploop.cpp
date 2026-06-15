// wasaploop — native Windows audio capture for ScreenCap Studio.
//   wasaploop.exe              -> default render endpoint loopback (ALL system audio)
//   wasaploop.exe <pid>        -> PROCESS loopback: only that process tree's audio
//                                 (the OS Application-Loopback API OBS uses for per-app audio)
//
// stderr on start:  WASAPI_FMT rate=<hz> ch=<n> bits=<n> float=<0|1>
// stdout: continuous interleaved PCM at that format (silence written as zeros).
//
// Build: cl /EHsc /O2 wasaploop.cpp /Fe:wasaploop.exe ole32.lib mmdevapi.lib

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmreg.h>
#include <wrl/implements.h>
#include <stdio.h>
#include <stdlib.h>
#include <io.h>
#include <fcntl.h>

#define REFTIMES_PER_SEC 10000000

using namespace Microsoft::WRL;

// Async activation completion handler. FtmBase makes it AGILE (free-threaded marshaler +
// IAgileObject) — without that ActivateAudioInterfaceAsync fails E_ILLEGAL_METHOD_CALL.
class ActivateHandler
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase, IActivateAudioInterfaceCompletionHandler> {
public:
    HANDLE done = CreateEvent(NULL, FALSE, FALSE, NULL);
    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation*) override { SetEvent(done); return S_OK; }
};

static void fixedFloatFormat(WAVEFORMATEX* f) {
    f->wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    f->nChannels = 2;
    f->nSamplesPerSec = 48000;
    f->wBitsPerSample = 32;
    f->nBlockAlign = f->nChannels * f->wBitsPerSample / 8;
    f->nAvgBytesPerSec = f->nSamplesPerSec * f->nBlockAlign;
    f->cbSize = 0;
}

// Default render endpoint loopback (all system audio). Returns the client + its mix format.
static IAudioClient* endpointClient(WAVEFORMATEX** pwfx) {
    IMMDeviceEnumerator* en = NULL;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), NULL, CLSCTX_ALL,
            __uuidof(IMMDeviceEnumerator), (void**)&en))) return NULL;
    IMMDevice* dev = NULL;
    if (FAILED(en->GetDefaultAudioEndpoint(eRender, eConsole, &dev))) return NULL;
    IAudioClient* c = NULL;
    if (FAILED(dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, NULL, (void**)&c))) return NULL;
    if (FAILED(c->GetMixFormat(pwfx))) return NULL;
    if (FAILED(c->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
            REFTIMES_PER_SEC, 0, *pwfx, NULL))) return NULL;
    return c;
}

// Process-tree loopback (only this process's audio). Fixed 48k/stereo/float.
static IAudioClient* processClient(DWORD pid, WAVEFORMATEX* fmt) {
    fixedFloatFormat(fmt);
    AUDIOCLIENT_ACTIVATION_PARAMS ap = {};
    ap.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    ap.ProcessLoopbackParams.TargetProcessId = pid;
    ap.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT pv = {};
    pv.vt = VT_BLOB;
    pv.blob.cbSize = sizeof(ap);
    pv.blob.pBlobData = (BYTE*)&ap;

    ComPtr<ActivateHandler> h = Make<ActivateHandler>();
    IActivateAudioInterfaceAsyncOperation* op = NULL;
    HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            __uuidof(IAudioClient), &pv, h.Get(), &op);
    if (FAILED(hr)) { fprintf(stderr, "activate-async 0x%08lx\n", hr); return NULL; }
    WaitForSingleObject(h->done, 5000);
    HRESULT ar = E_FAIL; IUnknown* unk = NULL;
    if (op) op->GetActivateResult(&ar, &unk);
    if (FAILED(ar) || !unk) { fprintf(stderr, "activate-result 0x%08lx\n", ar); return NULL; }
    IAudioClient* c = NULL;
    unk->QueryInterface(__uuidof(IAudioClient), (void**)&c);
    if (!c) return NULL;
    // Event-callback + LOOPBACK; bufferDuration MUST be 0 in event shared mode.
    hr = c->Initialize(AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
            0, 0, fmt, NULL);
    if (FAILED(hr)) { fprintf(stderr, "init 0x%08lx\n", hr); return NULL; }
    return c;
}

int main(int argc, char** argv) {
    _setmode(_fileno(stdout), _O_BINARY);
    // Establish a process-wide MTA. ActivateAudioInterfaceAsync (process loopback) returns
    // E_ILLEGAL_METHOD_CALL unless the implicit MTA is set up this way rather than via a
    // plain CoInitializeEx on the calling thread.
    CoInitializeEx(NULL, COINIT_MULTITHREADED);

    DWORD pid = (argc > 1) ? (DWORD)strtoul(argv[1], NULL, 10) : 0;
    WAVEFORMATEX fixed = {};
    WAVEFORMATEX* pwfx = NULL;
    HANDLE evt = NULL;
    IAudioClient* pClient = NULL;

    if (pid) {
        pClient = processClient(pid, &fixed);
        if (pClient) {
            pwfx = &fixed;
            evt = CreateEvent(NULL, FALSE, FALSE, NULL);
            pClient->SetEventHandle(evt);
        } else {
            // A specific app was requested but per-app capture failed. Do NOT fall back to
            // all-system audio — that silently leaks EVERY app's sound (e.g. recording Firefox
            // when only Discord was asked for). Fail; the caller gets no app audio rather than
            // the wrong audio. (pid==0 still uses the endpoint = all-system, by design.)
            fprintf(stderr, "process-loopback failed for pid %lu; refusing all-system fallback\n", pid);
            return 3;
        }
    } else {
        pClient = endpointClient(&pwfx);
    }
    if (!pClient || !pwfx) { fprintf(stderr, "WASAPI_FMT error\n"); return 2; }

    int isFloat = (pwfx->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) ||
                  (pwfx->wFormatTag == WAVE_FORMAT_EXTENSIBLE && pwfx->wBitsPerSample == 32);
    fprintf(stderr, "WASAPI_FMT rate=%u ch=%u bits=%u float=%d\n",
        pwfx->nSamplesPerSec, pwfx->nChannels, pwfx->wBitsPerSample, isFloat);
    fflush(stderr);

    IAudioCaptureClient* cap = NULL;
    if (FAILED(pClient->GetService(__uuidof(IAudioCaptureClient), (void**)&cap))) return 7;

    UINT32 bufFrames = 0; pClient->GetBufferSize(&bufFrames);
    DWORD sleepMs = (DWORD)(1000.0 * bufFrames / pwfx->nSamplesPerSec / 2.0);
    if (sleepMs < 2) sleepMs = 2;
    const UINT32 frameBytes = pwfx->nChannels * pwfx->wBitsPerSample / 8;

    // Report the engine's own stream latency (the unavoidable loopback buffer delay).
    REFERENCE_TIME streamLat = 0; pClient->GetStreamLatency(&streamLat);
    fprintf(stderr, "WASAPI_STREAM_LATENCY_MS=%.1f\n", (double)streamLat / 10000.0);
    fflush(stderr);

    if (FAILED(pClient->Start())) return 8;

    // SELF-ALIGNING START: the loopback buffer already holds audio that was rendered BEFORE we
    // started reading (a backlog of tens-to-hundreds of ms). If we emit it, it fills the front of
    // the stream and pushes ALL later audio late by that much — the "audio lags video" offset, and
    // it varies per run. WASAPI tags each packet with the QPC time it was rendered, so we DISCARD
    // stale packets at startup and only begin emitting once we've caught up to live audio (age small).
    // This puts the sync correction in the audio engine itself — no downstream offset/calibration.
    LARGE_INTEGER qfreq; QueryPerformanceFrequency(&qfreq);
    bool synced = false; int discarded = 0;

    static BYTE zeros[19200];
    for (;;) {
        if (evt) WaitForSingleObject(evt, 200); else Sleep(sleepMs);
        UINT32 packetLen = 0;
        if (FAILED(cap->GetNextPacketSize(&packetLen))) break;
        while (packetLen != 0) {
            BYTE* data = NULL; UINT32 frames = 0; DWORD flags = 0; UINT64 devpos = 0, qpcpos = 0;
            if (FAILED(cap->GetBuffer(&data, &frames, &flags, &devpos, &qpcpos))) { packetLen = 0; break; }
            if (!synced) {
                double age = 0;
                if (qpcpos > 0) {
                    LARGE_INTEGER now; QueryPerformanceCounter(&now);
                    UINT64 now100 = (UINT64)((double)now.QuadPart * 10000000.0 / (double)qfreq.QuadPart);
                    age = (double)((long long)(now100 - qpcpos)) / 10000.0; // ms old
                }
                if (qpcpos > 0 && age > 40.0 && discarded < 400) { // stale backlog → drop & keep draining
                    discarded++;
                    cap->ReleaseBuffer(frames);
                    if (FAILED(cap->GetNextPacketSize(&packetLen))) packetLen = 0;
                    continue;
                }
                synced = true; // caught up to live audio (or hit the safety cap); emit from here
                fprintf(stderr, "WASAPI_SYNCED age=%.1fms\n", age); fflush(stderr);
            }
            UINT32 bytes = frames * frameBytes;
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                UINT32 rem = bytes;
                while (rem > 0) { UINT32 c = rem < sizeof(zeros) ? rem : sizeof(zeros); fwrite(zeros, 1, c, stdout); rem -= c; }
            } else {
                fwrite(data, 1, bytes, stdout);
            }
            cap->ReleaseBuffer(frames);
            if (FAILED(cap->GetNextPacketSize(&packetLen))) { packetLen = 0; break; }
        }
        fflush(stdout);
    }
    return 0;
}
