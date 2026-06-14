// commshold.exe <seconds> — opens a COMMUNICATIONS-role capture stream (exactly what a
// VoIP app like Discord does when it joins a call) and holds it open for <seconds>. While
// it is open, the Windows audio engine's "Default Ducking Experience" attenuates every other
// (non-communications) render stream by the amount set in Sound > Communications. This is a
// diagnostic to PROVE that the "internal audio drops when the mic/call is active" is OS-level
// ducking, not the app's mixer. Build:
//   cl /EHsc /O2 commshold.cpp /Fe:commshold.exe ole32.lib
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <stdio.h>
#include <stdlib.h>

#define OK(hr, what) do { if (FAILED(hr)) { printf("FAIL %s 0x%08lx\n", what, (unsigned long)(hr)); return 1; } } while (0)

int main(int argc, char** argv) {
    int secs = (argc > 1) ? atoi(argv[1]) : 8;
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    OK(hr, "CoInitializeEx");

    IMMDeviceEnumerator* en = nullptr;
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                          __uuidof(IMMDeviceEnumerator), (void**)&en);
    OK(hr, "CoCreateInstance(enumerator)");

    // Default CAPTURE endpoint in the COMMUNICATIONS role — the canonical ducking trigger.
    IMMDevice* dev = nullptr;
    hr = en->GetDefaultAudioEndpoint(eCapture, eCommunications, &dev);
    OK(hr, "GetDefaultAudioEndpoint(eCapture,eCommunications)");

    IAudioClient2* ac = nullptr;
    hr = dev->Activate(__uuidof(IAudioClient2), CLSCTX_ALL, nullptr, (void**)&ac);
    OK(hr, "Activate(IAudioClient2)");

    // Tag the stream as a communications stream so Windows treats it like a call.
    AudioClientProperties props = {};
    props.cbSize = sizeof(props);
    props.bIsOffload = FALSE;
    props.eCategory = AudioCategory_Communications;
    hr = ac->SetClientProperties(&props);
    OK(hr, "SetClientProperties(Communications)");

    WAVEFORMATEX* wf = nullptr;
    hr = ac->GetMixFormat(&wf);
    OK(hr, "GetMixFormat");

    hr = ac->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 10000000 /*1s*/, 0, wf, nullptr);
    OK(hr, "Initialize");

    hr = ac->Start();
    OK(hr, "Start");

    printf("COMMS stream ACTIVE for %d s — Windows ducking other sounds now\n", secs);
    fflush(stdout);
    Sleep(secs * 1000);

    ac->Stop();
    printf("COMMS stream STOPPED — ducking released\n");
    fflush(stdout);
    return 0;
}
