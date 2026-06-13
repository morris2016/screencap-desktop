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
#include <mfapi.h>
#include <roapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <io.h>
#include <fcntl.h>

#define REFTIMES_PER_SEC 10000000

// ---- async activation completion handler. MUST be agile (aggregate a free-threaded
// marshaler) or ActivateAudioInterfaceAsync fails with E_ILLEGAL_METHOD_CALL. ----
class ActivateHandler : public IActivateAudioInterfaceCompletionHandler {
    long ref = 1;
    IUnknown* ftm = NULL;
public:
    HANDLE done;
    ActivateHandler() {
        done = CreateEvent(NULL, FALSE, FALSE, NULL);
        CoCreateFreeThreadedMarshaler(static_cast<IActivateAudioInterfaceCompletionHandler*>(this), &ftm);
    }
    ~ActivateHandler() { if (ftm) ftm->Release(); }
    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation*) { SetEvent(done); return S_OK; }
    STDMETHOD(QueryInterface)(REFIID riid, void** ppv) {
        if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this); AddRef(); return S_OK;
        }
        if (riid == __uuidof(IMarshal) && ftm) return ftm->QueryInterface(riid, ppv);
        *ppv = NULL; return E_NOINTERFACE;
    }
    STDMETHOD_(ULONG, AddRef)() { return InterlockedIncrement(&ref); }
    STDMETHOD_(ULONG, Release)() { long r = InterlockedDecrement(&ref); if (!r) delete this; return r; }
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

    ActivateHandler* h = new ActivateHandler();
    IActivateAudioInterfaceAsyncOperation* op = NULL;
    HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            __uuidof(IAudioClient), &pv, h, &op);
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
            // Per-app capture unavailable (older OS / restricted context) → full system audio.
            fprintf(stderr, "process-loopback unavailable, falling back to system audio\n");
        }
    }
    if (!pClient) pClient = endpointClient(&pwfx);
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

    if (FAILED(pClient->Start())) return 8;

    static BYTE zeros[19200];
    for (;;) {
        if (evt) WaitForSingleObject(evt, 200); else Sleep(sleepMs);
        UINT32 packetLen = 0;
        if (FAILED(cap->GetNextPacketSize(&packetLen))) break;
        while (packetLen != 0) {
            BYTE* data = NULL; UINT32 frames = 0; DWORD flags = 0;
            if (FAILED(cap->GetBuffer(&data, &frames, &flags, NULL, NULL))) { packetLen = 0; break; }
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
