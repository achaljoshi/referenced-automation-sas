# =====================================================================================================================
# sas-desktop-bridge.ps1 - the Windows desktop bridge of the SAS automation framework.
#
# NOT VERIFIED on a real Windows host with the real SAS applications (SAS Management Console, SAS Enterprise Guide):
# it was written on a machine without Windows or PowerShell. Everything on the TypeScript side of the protocol is tested
# against a Node stand-in that speaks the same line protocol; this file is checked only statically (ASCII + byte order
# mark, balanced braces, the same list of operations as the TypeScript protocol). Run `sas-desktop-inspect doctor` on a
# real desktop first, and treat the first runs as the conformance run.
#
# WHAT IT IS
#   One long-lived Windows PowerShell 5.1 process. It reads ONE JSON command per line on stdin and writes ONE JSON reply
#   per line on stdout:
#       -> {"rid": 7, "op": "getText", "ref": "e12"}
#       <- {"rid": 7, "ok": true, "value": "abc"}   or   {"rid": 7, "ok": false, "error": "...", "code": "NOT_FOUND"}
#   It first prints {"rid":0,"ok":true,"value":"ready"}. Codes: NOT_FOUND, SESSION_LOST, DENIED, NOT_IMPLEMENTED, ERROR.
#
# WHAT IT DOES
#   * Windows UI Automation (System.Windows.Automation): list windows, launch / attach to an application, find
#     controls, read their state, invoke / click / type / select / expand / toggle, screenshot, dump the control tree.
#   * Generic COM access (com.create / get / set / call / release) for the Enterprise Guide automation object model and
#     the Integration Technologies client. com.create only accepts ProgIDs that match the allow-list given at start
#     (-AllowProgIds; default SASEGObjectModel.Application.* and SASObjectManager.*); everything else is refused.
#   * Nothing else: no network access, no registry writes, no files written (a screenshot is returned as base64), no
#     modules, no downloads. The only programs it can start are the one `launch` is given a path for.
#
#   * The recorder of ADR 0002 (record.start / record.events / record.stop): a Windows hook thread plus UI Automation event handlers
#     that turn what a person does in ONE chosen program into events (see the RECORDER section below). NOT VERIFIED on Windows.
#
# WHAT IT NEVER DOES
#   * It never echoes text it was asked to type (setText / sendKeys) and never reads or returns the value of a password
#     field (IsPassword): trees, info and getText give an empty value for one, and screenshots paint password fields black.
#   * The recorder never records another program's windows, never records without a chosen program, never keeps a key press that went
#     to a secret field (a password field, or a name like password / pin / otp / token / secret / key) and never reads such a field's value.
#   * kill only stops processes this bridge launched or attached to.
#
# RUNNING IT
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File sas-desktop-bridge.ps1 [-AllowProgIds "A.*,B.*"]
#   Without -ExecutionPolicy Bypass when an approved (signed) copy is configured. The TypeScript side refuses to run a
#   copy whose SHA-256 differs from the one computed at build time (src/desktop/bridgeHash.generated.ts); an Authenticode
#   signature block at the end of the file is ignored by that check.
#   Older Enterprise Guide versions are 32-bit COM servers: start the 32-bit PowerShell
#   (C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe, setting SAS_DESKTOP_POWERSHELL) so the COM class is found.
#
# NEEDS: an unlocked, connected interactive desktop of the SAME user and elevation as the application under test (a
# normal bridge cannot automate an application started "as administrator").
#
# FILE FORMAT: ASCII text with a UTF-8 byte order mark, so Windows PowerShell 5.1 reads it correctly. Keep it that way.
# =====================================================================================================================
param(
    [string]$AllowProgIds = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

# Bumped together with BRIDGE_PROTOCOL_VERSION in src/desktop/bridgeProtocol.ts (a contract test compares them).
$script:BridgeVersion = 1

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# ---- native helpers (C# 5 compatible: Windows PowerShell 5.1 compiles with the .NET Framework compiler) -------------
$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class SasWin
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern bool IsHungAppWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll")]
    private static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    public static void EnableDpiAwareness()
    {
        try { SetProcessDPIAware(); } catch (Exception) { }
    }

    // False when the workstation is locked or the session is disconnected: the input desktop cannot be opened.
    public static bool DesktopAccessible()
    {
        IntPtr h = OpenInputDesktop(0, false, 0x0100);
        if (h == IntPtr.Zero) return false;
        CloseDesktop(h);
        return true;
    }

    public static bool IsHung(long hwnd)
    {
        if (hwnd == 0) return false;
        try { return IsHungAppWindow(new IntPtr(hwnd)); } catch (Exception) { return false; }
    }

    public static void Foreground(long hwnd)
    {
        if (hwnd == 0) return;
        IntPtr h = new IntPtr(hwnd);
        if (IsIconic(h)) ShowWindow(h, 9);
        SetForegroundWindow(h);
    }

    private static INPUT MouseInput(uint flags)
    {
        INPUT i = new INPUT();
        i.type = 0;
        i.u.mi.dwFlags = flags;
        return i;
    }

    private static void Send(INPUT[] inputs)
    {
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != (uint)inputs.Length)
        {
            throw new InvalidOperationException("SendInput delivered " + sent + " of " + inputs.Length + " events (the desktop is locked, or the target application runs with higher rights than this bridge)");
        }
    }

    // A real mouse click at screen pixel (x, y): the fallback when a control has no Invoke pattern.
    public static void MouseClick(int x, int y, bool right, int count)
    {
        SetCursorPos(x, y);
        uint down = right ? (uint)0x0008 : (uint)0x0002;
        uint up = right ? (uint)0x0010 : (uint)0x0004;
        INPUT[] inputs = new INPUT[count * 2];
        for (int n = 0; n < count; n++)
        {
            inputs[n * 2] = MouseInput(down);
            inputs[n * 2 + 1] = MouseInput(up);
        }
        Send(inputs);
    }

    // Types text as Unicode key events: independent of the keyboard layout, and no characters need escaping.
    public static void TypeText(string text)
    {
        List<INPUT> list = new List<INPUT>();
        foreach (char c in text)
        {
            if (c == '\r') continue;
            INPUT d = new INPUT();
            INPUT u = new INPUT();
            d.type = 1;
            u.type = 1;
            if (c == '\n')
            {
                d.u.ki.wVk = 0x0D;
                u.u.ki.wVk = 0x0D;
                u.u.ki.dwFlags = 0x0002;
            }
            else
            {
                d.u.ki.wScan = c;
                d.u.ki.dwFlags = 0x0004;
                u.u.ki.wScan = c;
                u.u.ki.dwFlags = 0x0004 | 0x0002;
            }
            list.Add(d);
            list.Add(u);
        }
        int offset = 0;
        while (offset < list.Count)
        {
            int take = Math.Min(200, list.Count - offset);
            INPUT[] chunk = new INPUT[take];
            list.CopyTo(offset, chunk, 0, take);
            Send(chunk);
            offset += take;
        }
    }
}
'@
Add-Type -TypeDefinition $nativeSource -Language CSharp

# InvokePattern.Invoke() on a button that opens a MODAL dialog does not return until the dialog is closed (WPF, WinForms,
# Win32). It is therefore called on its own thread; if it has not returned after waitMs the dialog is up and we carry on.
$invokeSource = @'
using System;
using System.Threading;
using System.Windows.Automation;

public static class SasInvoke
{
    // Returns "done" when Invoke returned (or threw: the exception is rethrown), "pending" when it is still running.
    public static string Run(InvokePattern pattern, int waitMs)
    {
        string error = null;
        Thread worker = new Thread(delegate ()
        {
            try { pattern.Invoke(); }
            catch (Exception ex) { error = ex.Message; }
        });
        worker.IsBackground = true;
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();
        if (worker.Join(waitMs))
        {
            if (error != null) throw new InvalidOperationException(error);
            return "done";
        }
        return "pending";
    }
}
'@
$uiaReferences = @(
    [System.Windows.Automation.AutomationElement].Assembly.Location,
    [System.Windows.Automation.ControlType].Assembly.Location,
    [System.Windows.Rect].Assembly.Location
)
Add-Type -TypeDefinition $invokeSource -Language CSharp -ReferencedAssemblies $uiaReferences

[SasWin]::EnableDpiAwareness()

# ---- the recorder (ADR 0002): NOT VERIFIED on Windows --------------------------------------------------------------
# Compiled on first use (record.start), not at start-up, so a bridge that never records pays nothing and a compile problem in this unverified
# part cannot stop the rest of the bridge: record.* then answers NOT_IMPLEMENTED with the compiler message. C# 5 compatible.
$recorderSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;

// NOT VERIFIED on Windows. The recorder of ADR 0002. Threads:
//   hook thread   STA, owns the two low-level hooks and their message loop. The hook procedures only look at the window under the
//                 pointer / the foreground window, and queue a small record. They never call UI Automation and never block.
//   work thread   MTA, the only place that talks to UI Automation: resolves the control behind each record, tidies it into an event.
//   UI Automation event handlers (their own threads) only queue records, too.
// Hooks are removed in a finally block; the queue and the event list are bounded; nothing is recorded unless target processes were given.
public static class SasRecorder
{
    // ---- Win32 -------------------------------------------------------------------------------------------------
    private delegate IntPtr LowLevelProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll")]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax, uint wRemoveMsg);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT pt);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern short GetKeyState(int nVirtKey);

    // ---- queue records -----------------------------------------------------------------------------------------
    private const int KindMouseDown = 1;
    private const int KindMouseUp = 2;
    private const int KindKey = 3;
    private const int KindFocus = 4;
    private const int KindInvoke = 5;
    private const int KindSelected = 6;
    private const int KindProperty = 7;
    private const int KindWindowOpened = 8;
    private const int KindWindowClosed = 9;
    private const int KindSecretKey = 10;

    private sealed class RawInput
    {
        public int Kind;
        public int X;
        public int Y;
        public int Button;
        public uint Vk;
        public bool Ctrl;
        public bool Alt;
        public bool Shift;
        public AutomationElement Element;
        public int[] RuntimeId;
        public object Extra;
        public AutomationProperty Property;
    }

    private sealed class PendingClick
    {
        public int Button;
        public int X;
        public int Y;
        public Dictionary<string, object> Target;
    }

    // What the user has typed into one field since the last commit. For a secret field only the fact is kept, never a value.
    private sealed class Typing
    {
        public AutomationElement Element;
        public Dictionary<string, object> Target;
        public bool Secret;
        public string Kind;
        public string Value;
        public bool Fresh;
        public long LastKeyAt;
        public string RuntimeKey;
    }

    private sealed class WindowRec
    {
        public string Title;
        public string ClassName;
        public string Process;
        public bool Owned;
    }

    // ---- state -------------------------------------------------------------------------------------------------
    private static readonly object Gate = new object();
    private static readonly object InboxLock = new object();
    private static readonly object OutboxLock = new object();
    private static readonly Queue<RawInput> Inbox = new Queue<RawInput>();
    private static readonly AutoResetEvent InboxSignal = new AutoResetEvent(false);
    private static readonly Dictionary<string, string> SecretWords = new Dictionary<string, string>();
    private static readonly Dictionary<int, string> ProcessNames = new Dictionary<int, string>();
    private static readonly Dictionary<string, WindowRec> Windows = new Dictionary<string, WindowRec>();
    private static readonly List<Dictionary<string, object>> Outbox = new List<Dictionary<string, object>>();
    private static readonly List<Regex> ExtraSecret = new List<Regex>();

    private static bool running;
    private static volatile bool stopping;
    private static volatile bool secretFocus;
    private static volatile bool stopRequested;
    private static volatile string hookError;
    private static volatile int[] targetPids = new int[0];
    private static int maxQueue = 5000;
    private static long dropped;
    private static long secretKeysDiscarded;
    private static long foreignKeysIgnored;
    private static bool useHooks;
    private static Stopwatch clock = new Stopwatch();
    private static Thread hookThread;
    private static Thread workThread;
    private static uint hookThreadId;
    private static IntPtr mouseHook = IntPtr.Zero;
    private static IntPtr keyboardHook = IntPtr.Zero;
    private static LowLevelProc mouseProc;
    private static LowLevelProc keyboardProc;
    private static ManualResetEvent hooksReady = new ManualResetEvent(false);
    private static ManualResetEvent workReady = new ManualResetEvent(false);
    private static uint stopVk;
    private static bool stopCtrl;
    private static bool stopAlt;
    private static bool stopShift;
    private static Typing typing;
    private static PendingClick pending;
    private static string lastWindowKey = "";
    private static string watchedValueKey = "";
    private static string watchedValue;
    private static AutomationElement watchedElement;
    private static Dictionary<string, object> watchedTarget;

    static SasRecorder()
    {
        string[] password = new string[] { "pwd", "pw", "pass", "passwd", "password", "passcode", "passphrase", "kennwort", "credential", "credentials" };
        foreach (string word in password) SecretWords[word] = "password";
        SecretWords["pin"] = "pin";
        SecretWords["otp"] = "otp";
        SecretWords["token"] = "token";
        SecretWords["secret"] = "secret";
        SecretWords["apikey"] = "key";
        SecretWords["key"] = "key";
    }

    // ---- public entry points (called from PowerShell) --------------------------------------------------------------
    public static Dictionary<string, object> Start(int[] pids, string mode, int queueLimit, string[] secretPatterns, string stopKey)
    {
        lock (Gate)
        {
            if (running) throw new InvalidOperationException("already recording: stop the running recording first (record.stop)");
            if (pids == null || pids.Length == 0) throw new InvalidOperationException("no target program: the recorder never records without a chosen program");
            maxQueue = queueLimit < 1 ? 5000 : queueLimit;
            ExtraSecret.Clear();
            if (secretPatterns != null)
            {
                foreach (string source in secretPatterns)
                {
                    if (!string.IsNullOrEmpty(source)) ExtraSecret.Add(new Regex(source, RegexOptions.IgnoreCase));
                }
            }
            ParseStopKey(stopKey);
            lock (InboxLock) { Inbox.Clear(); }
            lock (OutboxLock) { Outbox.Clear(); }
            Windows.Clear();
            dropped = 0;
            secretKeysDiscarded = 0;
            foreignKeysIgnored = 0;
            secretFocus = false;
            stopRequested = false;
            stopping = false;
            hookError = null;
            typing = null;
            pending = null;
            lastWindowKey = "";
            watchedValueKey = "";
            watchedValue = null;
            watchedElement = null;
            watchedTarget = null;
            targetPids = (int[])pids.Clone();
            useHooks = (mode != "uia");
            clock = Stopwatch.StartNew();

            workReady.Reset();
            workThread = new Thread(WorkLoop);
            workThread.SetApartmentState(ApartmentState.MTA);
            workThread.IsBackground = true;
            workThread.Start();
            if (!workReady.WaitOne(10000))
            {
                Shutdown();
                throw new InvalidOperationException("the recorder did not start in time (UI Automation did not answer)");
            }
            if (useHooks)
            {
                hooksReady.Reset();
                hookThread = new Thread(HookLoop);
                hookThread.SetApartmentState(ApartmentState.STA);
                hookThread.IsBackground = true;
                hookThread.Start();
                hooksReady.WaitOne(10000);
                if (hookError != null || mouseHook == IntPtr.Zero || keyboardHook == IntPtr.Zero)
                {
                    string why = hookError ?? "the hooks were not installed in time";
                    Shutdown();
                    throw new InvalidOperationException("could not install the mouse and keyboard hooks: " + why);
                }
            }
            running = true;
        }
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["startedAt"] = DateTime.UtcNow.ToString("o");
        return result;
    }

    public static Dictionary<string, object> Snapshot(bool drain)
    {
        if (!running) throw new InvalidOperationException("not recording: start the recorder first (record.start)");
        return BuildSnapshot(drain, false);
    }

    public static Dictionary<string, object> Stop()
    {
        lock (Gate)
        {
            if (!running) return BuildSnapshot(true, true);
            Shutdown();
            running = false;
        }
        return BuildSnapshot(true, true);
    }

    // Ends the threads and removes the hooks. The hook thread removes the hooks itself in a finally block.
    private static void Shutdown()
    {
        stopping = true;
        InboxSignal.Set();
        if (hookThreadId != 0)
        {
            PostThreadMessage(hookThreadId, 0x0012, IntPtr.Zero, IntPtr.Zero);
        }
        if (hookThread != null) hookThread.Join(4000);
        if (workThread != null) workThread.Join(8000);
        hookThread = null;
        workThread = null;
        hookThreadId = 0;
    }

    private static Dictionary<string, object> BuildSnapshot(bool drain, bool stoppedNow)
    {
        List<Dictionary<string, object>> events = new List<Dictionary<string, object>>();
        int left = 0;
        lock (OutboxLock)
        {
            int take = Outbox.Count;
            if (drain && take > 2000 && !stoppedNow) take = 2000;
            for (int i = 0; i < take; i++) events.Add(Outbox[i]);
            if (drain) Outbox.RemoveRange(0, take);
            left = Outbox.Count;
        }
        Dictionary<string, object> snapshot = new Dictionary<string, object>();
        snapshot["events"] = events;
        snapshot["dropped"] = Interlocked.Read(ref dropped);
        snapshot["secretKeysDiscarded"] = Interlocked.Read(ref secretKeysDiscarded);
        snapshot["foreignKeysIgnored"] = Interlocked.Read(ref foreignKeysIgnored);
        snapshot["recording"] = !stoppedNow;
        snapshot["targetAlive"] = TargetAlive();
        snapshot["stopRequested"] = stopRequested;
        snapshot["queued"] = left;
        snapshot["hooksRemoved"] = (mouseHook == IntPtr.Zero && keyboardHook == IntPtr.Zero);
        if (stoppedNow) snapshot["durationMs"] = clock.ElapsedMilliseconds;
        return snapshot;
    }

    private static bool TargetAlive()
    {
        int[] pids = targetPids;
        foreach (int pid in pids)
        {
            try
            {
                Process p = Process.GetProcessById(pid);
                if (!p.HasExited) return true;
            }
            catch (Exception) { }
        }
        return false;
    }

    // ---- hook thread ------------------------------------------------------------------------------------------
    private static void HookLoop()
    {
        try
        {
            mouseProc = MouseCallback;
            keyboardProc = KeyboardCallback;
            IntPtr module = GetModuleHandle(Process.GetCurrentProcess().MainModule.ModuleName);
            MSG msg;
            PeekMessage(out msg, IntPtr.Zero, 0, 0, 0);
            hookThreadId = GetCurrentThreadId();
            mouseHook = SetWindowsHookEx(14, mouseProc, module, 0);
            keyboardHook = SetWindowsHookEx(13, keyboardProc, module, 0);
            if (mouseHook == IntPtr.Zero || keyboardHook == IntPtr.Zero)
            {
                hookError = "SetWindowsHookEx failed (error " + Marshal.GetLastWin32Error().ToString() + ")";
                return;
            }
            hooksReady.Set();
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
        }
        catch (Exception ex)
        {
            hookError = ex.Message;
        }
        finally
        {
            if (mouseHook != IntPtr.Zero)
            {
                UnhookWindowsHookEx(mouseHook);
                mouseHook = IntPtr.Zero;
            }
            if (keyboardHook != IntPtr.Zero)
            {
                UnhookWindowsHookEx(keyboardHook);
                keyboardHook = IntPtr.Zero;
            }
            hooksReady.Set();
        }
    }

    private static bool IsTargetPid(int pid)
    {
        int[] pids = targetPids;
        for (int i = 0; i < pids.Length; i++)
        {
            if (pids[i] == pid) return true;
        }
        return false;
    }

    private static bool WindowBelongsToTarget(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return false;
        IntPtr root = GetAncestor(hwnd, 2);
        if (root == IntPtr.Zero) root = hwnd;
        uint pid;
        GetWindowThreadProcessId(root, out pid);
        return IsTargetPid((int)pid);
    }

    private static void Enqueue(RawInput item)
    {
        lock (InboxLock)
        {
            if (Inbox.Count >= maxQueue)
            {
                Interlocked.Increment(ref dropped);
                return;
            }
            Inbox.Enqueue(item);
        }
        InboxSignal.Set();
    }

    private static IntPtr MouseCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (nCode >= 0 && !stopping)
            {
                int msg = wParam.ToInt32();
                if (msg == 0x0201 || msg == 0x0202 || msg == 0x0204 || msg == 0x0205)
                {
                    MSLLHOOKSTRUCT info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                    // injected events (flag 1) are not the user's; a click on another program's window is not looked at any further
                    if ((info.flags & 0x01) == 0 && WindowBelongsToTarget(WindowFromPoint(info.pt)))
                    {
                        RawInput item = new RawInput();
                        item.Kind = (msg == 0x0201 || msg == 0x0204) ? KindMouseDown : KindMouseUp;
                        item.Button = (msg == 0x0201 || msg == 0x0202) ? 1 : 2;
                        item.X = info.pt.x;
                        item.Y = info.pt.y;
                        Enqueue(item);
                    }
                }
            }
        }
        catch (Exception) { }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    private static bool IsModifierVk(uint vk)
    {
        return vk == 0x10 || vk == 0x11 || vk == 0x12 || vk == 0x5B || vk == 0x5C || (vk >= 0xA0 && vk <= 0xA5);
    }

    // Only the Enter, Tab and Escape keys get through while a secret field has the focus: they carry no content.
    private static bool IsNonContentKey(uint vk)
    {
        return vk == 0x0D || vk == 0x09 || vk == 0x1B;
    }

    private static IntPtr KeyboardCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (nCode >= 0 && !stopping)
            {
                int msg = wParam.ToInt32();
                if (msg == 0x0100 || msg == 0x0104)
                {
                    KBDLLHOOKSTRUCT info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                    if ((info.flags & 0x10) == 0 && !IsModifierVk(info.vkCode))
                    {
                        bool ctrl = (GetKeyState(0x11) & 0x8000) != 0;
                        bool alt = (GetKeyState(0x12) & 0x8000) != 0;
                        bool shift = (GetKeyState(0x10) & 0x8000) != 0;
                        if (stopVk != 0 && info.vkCode == stopVk && ctrl == stopCtrl && alt == stopAlt && shift == stopShift)
                        {
                            // the stop chord is noticed in any window and recorded in none
                            stopRequested = true;
                        }
                        else if (WindowBelongsToTarget(GetForegroundWindow()))
                        {
                            if (secretFocus && !IsNonContentKey(info.vkCode))
                            {
                                // a secret field has the focus: the key is thrown away right here, only counted
                                Interlocked.Increment(ref secretKeysDiscarded);
                                RawInput note = new RawInput();
                                note.Kind = KindSecretKey;
                                Enqueue(note);
                            }
                            else
                            {
                                RawInput item = new RawInput();
                                item.Kind = KindKey;
                                item.Vk = info.vkCode;
                                item.Ctrl = ctrl;
                                item.Alt = alt;
                                item.Shift = shift;
                                Enqueue(item);
                            }
                        }
                        else
                        {
                            Interlocked.Increment(ref foreignKeysIgnored);
                        }
                    }
                }
            }
        }
        catch (Exception) { }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    // ---- stop chord -------------------------------------------------------------------------------------------
    private static void ParseStopKey(string spec)
    {
        stopVk = 0;
        stopCtrl = false;
        stopAlt = false;
        stopShift = false;
        if (string.IsNullOrEmpty(spec)) return;
        string[] parts = spec.Split(new char[] { '+' });
        string key = parts[parts.Length - 1].Trim();
        for (int i = 0; i < parts.Length - 1; i++)
        {
            string mod = parts[i].Trim().ToLowerInvariant();
            if (mod == "ctrl" || mod == "control") stopCtrl = true;
            else if (mod == "alt") stopAlt = true;
            else if (mod == "shift") stopShift = true;
            else throw new InvalidOperationException("stopKey: unknown modifier " + parts[i]);
        }
        if (key.Length == 1 && char.IsLetterOrDigit(key[0])) stopVk = (uint)char.ToUpperInvariant(key[0]);
        else if (key.Length >= 2 && (key[0] == 'F' || key[0] == 'f') && key.Length <= 3)
        {
            int n;
            if (int.TryParse(key.Substring(1), out n) && n >= 1 && n <= 24) stopVk = (uint)(0x6F + n);
        }
        else if (string.Equals(key, "Escape", StringComparison.OrdinalIgnoreCase)) stopVk = 0x1B;
        else if (string.Equals(key, "Enter", StringComparison.OrdinalIgnoreCase)) stopVk = 0x0D;
        if (stopVk == 0) throw new InvalidOperationException("stopKey: " + spec + " is not a key chord such as Ctrl+Alt+Q");
    }

    // ---- secrets ------------------------------------------------------------------------------------------------
    private static string[] WordsOf(string text)
    {
        string spaced = Regex.Replace(text, "([a-z0-9])([A-Z])", "$1 $2").ToLowerInvariant();
        List<string> words = new List<string>();
        foreach (string w in Regex.Split(spaced, "[^a-z0-9]+"))
        {
            if (w.Length > 0) words.Add(w);
        }
        return words.ToArray();
    }

    // The kind of secret a name suggests, judged by whole words; null when it does not look like one.
    private static string SecretKindOfName(string text)
    {
        if (string.IsNullOrEmpty(text)) return null;
        foreach (string word in WordsOf(text))
        {
            string kind;
            if (SecretWords.TryGetValue(word, out kind)) return kind;
        }
        foreach (Regex extra in ExtraSecret)
        {
            if (extra.IsMatch(text)) return "secret";
        }
        return null;
    }

    private static string SafeName(AutomationElement el)
    {
        try { return el.Current.Name; } catch (Exception) { return ""; }
    }

    private static string SafeId(AutomationElement el)
    {
        try { return el.Current.AutomationId; } catch (Exception) { return ""; }
    }

    // A password field is a secret by the control itself (IsPassword), else by its name, automation id, help text or its label.
    private static string SecretKindOf(AutomationElement el)
    {
        try
        {
            if (el.Current.IsPassword) return "password";
        }
        catch (Exception) { return "password"; }
        string kind = SecretKindOfName(SafeName(el));
        if (kind == null) kind = SecretKindOfName(SafeId(el));
        if (kind == null)
        {
            try { kind = SecretKindOfName(el.Current.HelpText); } catch (Exception) { }
        }
        if (kind == null)
        {
            try
            {
                AutomationElement label = el.Current.LabeledBy;
                if (label != null) kind = SecretKindOfName(SafeName(label));
            }
            catch (Exception) { }
        }
        return kind;
    }

    private static bool IsEditable(AutomationElement el)
    {
        try
        {
            ControlType t = el.Current.ControlType;
            return t == ControlType.Edit || t == ControlType.Document || t == ControlType.ComboBox || t == ControlType.Spinner;
        }
        catch (Exception) { return false; }
    }

    // ---- targets (locator candidate chains) -------------------------------------------------------------------
    private static string TypeName(AutomationElement el)
    {
        try { return el.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""); } catch (Exception) { return ""; }
    }

    private static string TitlePattern(string title)
    {
        return "^" + Regex.Replace(title, "[\\\\^$.|?*+()\\[\\]{}]", "\\$&") + "$";
    }

    private static string RidKey(int[] rid)
    {
        if (rid == null) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < rid.Length; i++)
        {
            if (i > 0) sb.Append("-");
            sb.Append(rid[i].ToString());
        }
        return sb.ToString();
    }

    private static string ProcessNameOf(int pid)
    {
        string name;
        if (ProcessNames.TryGetValue(pid, out name)) return name;
        try { name = Process.GetProcessById(pid).ProcessName; } catch (Exception) { name = ""; }
        ProcessNames[pid] = name;
        return name;
    }

    private static AutomationElement WindowOfElement(AutomationElement el, List<AutomationElement> chain)
    {
        TreeWalker walker = TreeWalker.ControlViewWalker;
        AutomationElement root = AutomationElement.RootElement;
        AutomationElement cursor = el;
        for (int i = 0; i < 60 && cursor != null; i++)
        {
            if (cursor.Current.ControlType == ControlType.Window) return cursor;
            AutomationElement parent = walker.GetParent(cursor);
            if (parent == null || Automation.Compare(parent, root)) break;
            if (chain != null) chain.Add(cursor);
            cursor = parent;
        }
        // no Window ancestor (a Swing frame that does not say so): the top of the chain stands for the window
        return cursor;
    }

    private static Dictionary<string, object> WindowInfoOf(AutomationElement window)
    {
        string title = SafeName(window);
        Dictionary<string, object> info = new Dictionary<string, object>();
        info["titlePattern"] = TitlePattern(title);
        info["title"] = title;
        string className = "";
        try { className = window.Current.ClassName; } catch (Exception) { }
        if (className.Length > 0) info["className"] = className;
        return info;
    }

    private static int CountMatches(AutomationElement window, Condition condition, int cap)
    {
        int count = 0;
        try
        {
            foreach (AutomationElement item in window.FindAll(TreeScope.Descendants, condition))
            {
                count++;
                if (count >= cap) break;
            }
        }
        catch (Exception) { }
        return count;
    }

    // The ordinal among the window's elements with the same control type and class name, in document order (the number .nth() takes).
    private static int IndexAmongSameKind(AutomationElement window, AutomationElement el)
    {
        try
        {
            Condition both = new AndCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, el.Current.ControlType),
                new PropertyCondition(AutomationElement.ClassNameProperty, el.Current.ClassName));
            int n = 0;
            foreach (AutomationElement item in window.FindAll(TreeScope.Descendants, both))
            {
                if (Automation.Compare(item, el)) return n;
                n++;
                if (n > 400) break;
            }
        }
        catch (Exception) { }
        return 0;
    }

    private static Dictionary<string, object> StepOf(AutomationElement window, AutomationElement el)
    {
        Dictionary<string, object> step = new Dictionary<string, object>();
        string type = TypeName(el);
        string name = SafeName(el);
        string id = SafeId(el);
        string className = "";
        try { className = el.Current.ClassName; } catch (Exception) { }
        if (type.Length > 0) step["controlType"] = type;
        if (name.Length > 0) step["name"] = name;
        if (id.Length > 0) step["automationId"] = id;
        if (className.Length > 0) step["className"] = className;
        if (name.Length == 0 && id.Length == 0) step["index"] = IndexAmongSameKind(window, el);
        return step;
    }

    // From the window down to the control; the last step is the control itself. px/py: where the pointer was (screen pixels), or -1.
    private static Dictionary<string, object> BuildTarget(AutomationElement el, int px, int py)
    {
        List<AutomationElement> up = new List<AutomationElement>();
        AutomationElement window = WindowOfElement(el, up);
        // up holds the control and its ancestors up to (not including) the window, nearest first
        // the nearest ancestors that can be told apart (an automation id or a name), at most six, plus the control itself
        List<AutomationElement> kept = new List<AutomationElement>();
        for (int i = 0; i < up.Count; i++)
        {
            AutomationElement item = up[i];
            if (i == 0 || (kept.Count < 7 && (SafeName(item).Length > 0 || SafeId(item).Length > 0))) kept.Add(item);
        }
        kept.Reverse();
        Dictionary<string, object> target = new Dictionary<string, object>();
        target["window"] = WindowInfoOf(window);
        List<object> path = new List<object>();
        foreach (AutomationElement item in kept) path.Add(StepOf(window, item));
        target["path"] = path;
        if (!Automation.Compare(window, el))
        {
            Dictionary<string, object> unique = new Dictionary<string, object>();
            string id = SafeId(el);
            string name = SafeName(el);
            if (id.Length > 0) unique["automationId"] = CountMatches(window, new PropertyCondition(AutomationElement.AutomationIdProperty, id), 2) == 1;
            if (name.Length > 0)
            {
                Condition both = new AndCondition(new PropertyCondition(AutomationElement.NameProperty, name), new PropertyCondition(AutomationElement.ControlTypeProperty, el.Current.ControlType));
                unique["nameAndType"] = CountMatches(window, both, 2) == 1;
            }
            if (unique.Count > 0) target["unique"] = unique;
        }
        try
        {
            System.Windows.Rect wr = window.Current.BoundingRectangle;
            System.Windows.Rect er = el.Current.BoundingRectangle;
            if (!wr.IsEmpty && !er.IsEmpty && !double.IsInfinity(er.X) && !double.IsInfinity(er.Width))
            {
                Dictionary<string, object> bounds = new Dictionary<string, object>();
                bounds["x"] = (int)(er.X - wr.X);
                bounds["y"] = (int)(er.Y - wr.Y);
                bounds["width"] = (int)er.Width;
                bounds["height"] = (int)er.Height;
                target["bounds"] = bounds;
                Dictionary<string, object> point = new Dictionary<string, object>();
                if (px >= 0 && py >= 0)
                {
                    point["x"] = (int)(px - wr.X);
                    point["y"] = (int)(py - wr.Y);
                }
                else
                {
                    point["x"] = (int)(er.X - wr.X + er.Width / 2);
                    point["y"] = (int)(er.Y - wr.Y + er.Height / 2);
                }
                target["fallbackPoint"] = point;
            }
        }
        catch (Exception) { }
        return target;
    }

    // ---- events -----------------------------------------------------------------------------------------------
    private static Dictionary<string, object> NewEvent(string type)
    {
        Dictionary<string, object> ev = new Dictionary<string, object>();
        ev["type"] = type;
        ev["t"] = clock.ElapsedMilliseconds;
        return ev;
    }

    private static void Emit(Dictionary<string, object> ev)
    {
        lock (OutboxLock)
        {
            if (Outbox.Count >= maxQueue)
            {
                Interlocked.Increment(ref dropped);
                return;
            }
            Outbox.Add(ev);
        }
    }

    private static void EmitWindow(string type, AutomationElement window)
    {
        string title = SafeName(window);
        int pid = 0;
        try { pid = window.Current.ProcessId; } catch (Exception) { }
        bool owned = false;
        try
        {
            AutomationElement parent = TreeWalker.ControlViewWalker.GetParent(window);
            owned = parent != null && !Automation.Compare(parent, AutomationElement.RootElement);
        }
        catch (Exception) { }
        WindowRec rec = new WindowRec();
        rec.Title = title;
        try { rec.ClassName = window.Current.ClassName; } catch (Exception) { rec.ClassName = ""; }
        rec.Process = ProcessNameOf(pid);
        rec.Owned = owned;
        try { Windows[RidKey(window.GetRuntimeId())] = rec; } catch (Exception) { }
        EmitWindowRec(type, rec);
    }

    private static void EmitWindowRec(string type, WindowRec rec)
    {
        Dictionary<string, object> ev = NewEvent(type);
        ev["title"] = rec.Title;
        if (!string.IsNullOrEmpty(rec.ClassName)) ev["className"] = rec.ClassName;
        if (!string.IsNullOrEmpty(rec.Process)) ev["process"] = rec.Process;
        if (rec.Owned) ev["owned"] = true;
        Emit(ev);
    }

    // ---- UI Automation (registered on the work thread; the handlers only queue) --------------------------------
    private static void AttachWindow(AutomationElement window)
    {
        try
        {
            Automation.AddAutomationEventHandler(InvokePattern.InvokedEvent, window, TreeScope.Subtree, OnInvoked);
            Automation.AddAutomationEventHandler(SelectionItemPattern.ElementSelectedEvent, window, TreeScope.Subtree, OnSelected);
            Automation.AddAutomationEventHandler(SelectionItemPattern.ElementAddedToSelectionEvent, window, TreeScope.Subtree, OnSelected);
            Automation.AddAutomationPropertyChangedEventHandler(window, TreeScope.Subtree, OnPropertyChanged, TogglePattern.ToggleStateProperty, ExpandCollapsePattern.ExpandCollapseStateProperty);
        }
        catch (Exception) { }
    }

    private static bool SenderInTarget(object sender, out AutomationElement el)
    {
        el = sender as AutomationElement;
        if (el == null) return false;
        try { return IsTargetPid(el.Current.ProcessId); } catch (Exception) { return false; }
    }

    private static void OnInvoked(object sender, AutomationEventArgs e)
    {
        AutomationElement el;
        if (!SenderInTarget(sender, out el)) return;
        RawInput item = new RawInput();
        item.Kind = KindInvoke;
        item.Element = el;
        Enqueue(item);
    }

    private static void OnSelected(object sender, AutomationEventArgs e)
    {
        AutomationElement el;
        if (!SenderInTarget(sender, out el)) return;
        RawInput item = new RawInput();
        item.Kind = KindSelected;
        item.Element = el;
        if (e.EventId.Id == SelectionItemPattern.ElementAddedToSelectionEvent.Id) item.Extra = "added";
        Enqueue(item);
    }

    private static void OnPropertyChanged(object sender, AutomationPropertyChangedEventArgs e)
    {
        AutomationElement el;
        if (!SenderInTarget(sender, out el)) return;
        RawInput item = new RawInput();
        item.Kind = KindProperty;
        item.Element = el;
        item.Extra = e.NewValue;
        item.Property = e.Property;
        Enqueue(item);
    }

    private static void OnWindowOpened(object sender, AutomationEventArgs e)
    {
        AutomationElement el;
        if (!SenderInTarget(sender, out el)) return;
        RawInput item = new RawInput();
        item.Kind = KindWindowOpened;
        item.Element = el;
        Enqueue(item);
    }

    private static void OnWindowClosed(object sender, AutomationEventArgs e)
    {
        try
        {
            WindowClosedEventArgs closed = e as WindowClosedEventArgs;
            if (closed == null) return;
            RawInput item = new RawInput();
            item.Kind = KindWindowClosed;
            item.RuntimeId = closed.GetRuntimeId();
            Enqueue(item);
        }
        catch (Exception) { }
    }

    private static void OnFocus(object sender, AutomationFocusChangedEventArgs e)
    {
        AutomationElement el = sender as AutomationElement;
        if (el == null) return;
        try
        {
            if (!IsTargetPid(el.Current.ProcessId))
            {
                secretFocus = false;
                return;
            }
            // decided here, at once, so the keyboard hook can throw keys away before the work thread has looked
            secretFocus = SecretKindOf(el) != null;
            RawInput item = new RawInput();
            item.Kind = KindFocus;
            item.Element = el;
            Enqueue(item);
        }
        catch (Exception)
        {
            // cannot tell: treat as secret until the next focus change (keys are thrown away, never recorded)
            secretFocus = true;
        }
    }

    private static void InitUia()
    {
        AutomationElement root = AutomationElement.RootElement;
        Automation.AddAutomationFocusChangedEventHandler(OnFocus);
        Automation.AddAutomationEventHandler(WindowPattern.WindowOpenedEvent, root, TreeScope.Subtree, OnWindowOpened);
        Automation.AddAutomationEventHandler(WindowPattern.WindowClosedEvent, root, TreeScope.Subtree, OnWindowClosed);
        foreach (AutomationElement top in root.FindAll(TreeScope.Children, Condition.TrueCondition))
        {
            try
            {
                if (!IsTargetPid(top.Current.ProcessId) || SafeName(top).Length == 0) continue;
                AttachWindow(top);
                EmitWindow("windowOpened", top);
                foreach (AutomationElement nested in top.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Window)))
                {
                    if (SafeName(nested).Length == 0) continue;
                    AttachWindow(nested);
                    EmitWindow("windowOpened", nested);
                }
            }
            catch (Exception) { }
        }
    }

    // ---- work thread ------------------------------------------------------------------------------------------
    private static void WorkLoop()
    {
        try
        {
            InitUia();
            workReady.Set();
            while (true)
            {
                RawInput item = null;
                lock (InboxLock)
                {
                    if (Inbox.Count > 0) item = Inbox.Dequeue();
                }
                if (item == null)
                {
                    if (stopping) break;
                    InboxSignal.WaitOne(100);
                    try { Idle(); } catch (Exception) { }
                    continue;
                }
                try { Handle(item); } catch (Exception) { }
            }
            try { FlushTyping("blur"); } catch (Exception) { }
            try { FlushWatched(); } catch (Exception) { }
        }
        catch (Exception ex)
        {
            if (hookError == null) hookError = "the recorder work thread failed: " + ex.Message;
        }
        finally
        {
            try { Automation.RemoveAllEventHandlers(); } catch (Exception) { }
            workReady.Set();
        }
    }

    // While nobody types: read the field the user was typing into once typing has paused (so the value is known before a click or Enter can change the screen).
    private static void Idle()
    {
        Typing t = typing;
        if (t != null && !t.Secret && !t.Fresh && clock.ElapsedMilliseconds - t.LastKeyAt >= 150)
        {
            ReadTypingValue(t);
        }
    }

    private static void ReadTypingValue(Typing t)
    {
        try
        {
            object pattern;
            if (t.Element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
            {
                t.Value = ((ValuePattern)pattern).Current.Value;
                t.Fresh = true;
            }
        }
        catch (Exception) { }
    }

    private static AutomationElement Focused()
    {
        try { return AutomationElement.FocusedElement; } catch (Exception) { return null; }
    }

    private static void Handle(RawInput item)
    {
        switch (item.Kind)
        {
            case KindMouseDown: HandleMouseDown(item); break;
            case KindMouseUp: HandleMouseUp(item); break;
            case KindKey: HandleKey(item); break;
            case KindSecretKey: HandleSecretKey(); break;
            case KindFocus: HandleFocus(item); break;
            case KindInvoke: HandleInvoke(item); break;
            case KindSelected: HandleSelected(item); break;
            case KindProperty: HandleProperty(item); break;
            case KindWindowOpened: HandleWindowOpened(item); break;
            case KindWindowClosed: HandleWindowClosed(item); break;
        }
    }

    private static void HandleMouseDown(RawInput item)
    {
        FlushTyping("blur"); // what was typed is committed before the click can change the screen
        pending = null;
        AutomationElement el = AutomationElement.FromPoint(new System.Windows.Point(item.X, item.Y));
        if (el == null || !IsTargetPid(el.Current.ProcessId)) return;
        if (SecretKindOf(el) != null) secretFocus = true;
        PendingClick click = new PendingClick();
        click.Button = item.Button;
        click.X = item.X;
        click.Y = item.Y;
        click.Target = BuildTarget(el, item.X, item.Y);
        pending = click;
    }

    private static void HandleMouseUp(RawInput item)
    {
        PendingClick click = pending;
        pending = null;
        if (click == null || click.Button != item.Button) return;
        if (Math.Abs(click.X - item.X) > 4 || Math.Abs(click.Y - item.Y) > 4) return; // a drag, not a click
        Dictionary<string, object> ev = NewEvent(click.Button == 2 ? "rightClick" : "click");
        ev["target"] = click.Target;
        Emit(ev);
    }

    private static string KeyName(uint vk)
    {
        if (vk >= 0x41 && vk <= 0x5A) return ((char)vk).ToString();
        if (vk >= 0x30 && vk <= 0x39) return ((char)vk).ToString();
        if (vk >= 0x70 && vk <= 0x87) return "F" + (vk - 0x6F).ToString();
        switch (vk)
        {
            case 0x0D: return "Enter";
            case 0x1B: return "Escape";
            case 0x09: return "Tab";
            case 0x2E: return "Delete";
            case 0x2D: return "Insert";
            case 0x24: return "Home";
            case 0x23: return "End";
            case 0x21: return "PageUp";
            case 0x22: return "PageDown";
            case 0x26: return "Up";
            case 0x28: return "Down";
            case 0x25: return "Left";
            case 0x27: return "Right";
            case 0x20: return "Space";
            case 0x08: return "Backspace";
        }
        return null;
    }

    private static bool IsPrintableVk(uint vk)
    {
        return (vk >= 0x30 && vk <= 0x5A) || vk == 0x20 || (vk >= 0x60 && vk <= 0x6F) || (vk >= 0xBA && vk <= 0xC0) || (vk >= 0xDB && vk <= 0xDF);
    }

    private static void HandleKey(RawInput item)
    {
        bool chord = item.Ctrl || item.Alt;
        uint vk = item.Vk;
        string name = KeyName(vk);
        // editing: printable keys, Backspace and Delete in a field, and the clipboard chords that change one
        bool pasteOrCut = item.Ctrl && !item.Alt && (vk == 0x56 || vk == 0x58);
        bool editing = (!chord && (IsPrintableVk(vk) || vk == 0x08 || vk == 0x2E)) || pasteOrCut || (item.Shift && vk == 0x2D);
        if (editing)
        {
            NoteTyping();
            return;
        }
        if (name == null) return;
        if (!chord && (vk == 0x26 || vk == 0x28 || vk == 0x25 || vk == 0x27 || vk == 0x24 || vk == 0x23 || vk == 0x21 || vk == 0x22 || vk == 0x2D || vk == 0x20)) return; // navigation inside a control
        if (item.Ctrl && !item.Alt && (vk == 0x43 || vk == 0x41 || vk == 0x5A || vk == 0x59 || vk == 0x2D)) return; // copy, select all, undo, redo: no step
        if (vk == 0x0D || vk == 0x09)
        {
            if (typing != null)
            {
                FlushTyping(vk == 0x0D ? "enter" : "tab"); // the commit key belongs to the field it committed
                return;
            }
            if (vk == 0x09) return;
        }
        else FlushTyping("blur");
        string keys = (item.Ctrl ? "Ctrl+" : "") + (item.Alt ? "Alt+" : "") + (item.Shift ? "Shift+" : "") + name;
        Dictionary<string, object> ev = NewEvent("key");
        AutomationElement focused = Focused();
        AutomationElement window = focused != null ? WindowOfElement(focused, null) : null;
        if (window == null) return;
        ev["keys"] = keys;
        ev["window"] = WindowInfoOf(window);
        if (focused != null && !Automation.Compare(focused, window) && SecretKindOf(focused) == null) ev["target"] = BuildTarget(focused, -1, -1);
        Emit(ev);
    }

    // A key was typed (a printable one, or an edit) while a non-secret field may have the focus: remember which field.
    private static void NoteTyping()
    {
        AutomationElement focused = Focused();
        if (focused == null || !IsTargetPid(focused.Current.ProcessId)) return;
        string kind = SecretKindOf(focused);
        if (kind != null)
        {
            // the keyboard hook should have thrown this away; do not keep anything but the fact
            Interlocked.Increment(ref secretKeysDiscarded);
            NoteSecretTyping(focused, kind);
            return;
        }
        if (!IsEditable(focused)) return;
        string key = RidKey(focused.GetRuntimeId());
        Typing t = typing;
        if (t != null && t.RuntimeKey != key) FlushTyping("blur");
        t = typing;
        if (t == null)
        {
            t = new Typing();
            t.Element = focused;
            t.RuntimeKey = key;
            t.Target = BuildTarget(focused, -1, -1);
            typing = t;
        }
        t.Fresh = false;
        t.LastKeyAt = clock.ElapsedMilliseconds;
    }

    private static void HandleSecretKey()
    {
        AutomationElement focused = Focused();
        if (focused == null) return;
        string kind = SecretKindOf(focused);
        if (kind == null) kind = "password";
        NoteSecretTyping(focused, kind);
    }

    private static void NoteSecretTyping(AutomationElement focused, string kind)
    {
        string key = RidKey(focused.GetRuntimeId());
        Typing t = typing;
        if (t != null && t.RuntimeKey != key) FlushTyping("blur");
        t = typing;
        if (t == null)
        {
            t = new Typing();
            t.Element = focused;
            t.RuntimeKey = key;
            t.Secret = true;
            t.Kind = kind;
            t.Target = BuildTarget(focused, -1, -1);
            typing = t;
        }
    }

    // Turns what was typed into one `typed` event. A secret field gives only the fact; its value is never read.
    private static void FlushTyping(string by)
    {
        Typing t = typing;
        typing = null;
        if (t == null) return;
        Dictionary<string, object> ev = NewEvent("typed");
        ev["target"] = t.Target;
        if (t.Secret)
        {
            ev["secret"] = true;
            ev["secretKind"] = t.Kind;
        }
        else
        {
            if (!t.Fresh) ReadTypingValue(t);
            if (t.Value == null) return; // the control has no readable value: nothing can be recorded for it
            ev["value"] = t.Value;
        }
        ev["committedBy"] = by;
        Emit(ev);
    }

    private static void HandleFocus(RawInput item)
    {
        AutomationElement el = item.Element;
        if (typing != null && typing.RuntimeKey != RidKey(el.GetRuntimeId())) FlushTyping("blur");
        AutomationElement window = WindowOfElement(el, null);
        string key = RidKey(window.GetRuntimeId());
        if (key != lastWindowKey)
        {
            lastWindowKey = key;
            WindowRec rec = new WindowRec();
            rec.Title = SafeName(window);
            try { rec.ClassName = window.Current.ClassName; } catch (Exception) { rec.ClassName = ""; }
            rec.Process = ProcessNameOf(el.Current.ProcessId);
            EmitWindowRec("windowActivated", rec);
        }
        if (!useHooks) WatchFocus(el);
    }

    // UI Automation only mode (no hooks): a field the focus leaves is read once; a changed value is a typed event. Never for a secret field.
    private static void WatchFocus(AutomationElement el)
    {
        FlushWatched();
        if (!IsEditable(el) || SecretKindOf(el) != null) return;
        try
        {
            object pattern;
            if (!el.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return;
            watchedElement = el;
            watchedValue = ((ValuePattern)pattern).Current.Value;
            watchedTarget = BuildTarget(el, -1, -1);
        }
        catch (Exception) { }
    }

    private static void FlushWatched()
    {
        AutomationElement el = watchedElement;
        Dictionary<string, object> target = watchedTarget;
        string before = watchedValue;
        watchedElement = null;
        watchedTarget = null;
        watchedValue = null;
        if (el == null || target == null) return;
        try
        {
            object pattern;
            if (!el.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return;
            string after = ((ValuePattern)pattern).Current.Value;
            if (after == before) return;
            Dictionary<string, object> ev = NewEvent("typed");
            ev["target"] = target;
            ev["value"] = after;
            ev["committedBy"] = "blur";
            Emit(ev);
        }
        catch (Exception) { }
    }

    private static void HandleInvoke(RawInput item)
    {
        Dictionary<string, object> ev = NewEvent("invoke");
        ev["target"] = BuildTarget(item.Element, -1, -1);
        Emit(ev);
    }

    private static void HandleSelected(RawInput item)
    {
        Dictionary<string, object> ev = NewEvent("selected");
        ev["target"] = BuildTarget(item.Element, -1, -1);
        if ("added".Equals(item.Extra)) ev["added"] = true;
        try
        {
            object pattern;
            if (item.Element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
            {
                AutomationElement container = ((SelectionItemPattern)pattern).Current.SelectionContainer;
                if (container != null) ev["container"] = BuildTarget(container, -1, -1);
            }
        }
        catch (Exception) { }
        Emit(ev);
    }

    private static void HandleProperty(RawInput item)
    {
        if (item.Property.Id == TogglePattern.ToggleStateProperty.Id)
        {
            Dictionary<string, object> ev = NewEvent("toggled");
            ev["target"] = BuildTarget(item.Element, -1, -1);
            ev["state"] = (item.Extra is ToggleState) && ((ToggleState)item.Extra == ToggleState.On);
            Emit(ev);
        }
        else if (item.Property.Id == ExpandCollapsePattern.ExpandCollapseStateProperty.Id && item.Extra is ExpandCollapseState)
        {
            ExpandCollapseState state = (ExpandCollapseState)item.Extra;
            if (state == ExpandCollapseState.Expanded || state == ExpandCollapseState.Collapsed)
            {
                Dictionary<string, object> ev = NewEvent(state == ExpandCollapseState.Expanded ? "expanded" : "collapsed");
                ev["target"] = BuildTarget(item.Element, -1, -1);
                Emit(ev);
            }
        }
    }

    private static void HandleWindowOpened(RawInput item)
    {
        if (SafeName(item.Element).Length == 0) return;
        AttachWindow(item.Element);
        EmitWindow("windowOpened", item.Element);
    }

    private static void HandleWindowClosed(RawInput item)
    {
        string key = RidKey(item.RuntimeId);
        WindowRec rec;
        if (!Windows.TryGetValue(key, out rec)) return; // not a window of the recorded program
        Windows.Remove(key);
        EmitWindowRec("windowClosed", rec);
    }
}
'@
$script:RecorderLoaded = $false
$script:RecorderError = $null

# ---- small helpers -------------------------------------------------------------------------------------------------
$script:result = $null
$script:refToElement = @{}
$script:keyToRef = @{}
$script:nextRef = 1
$script:comHandles = @{}
$script:nextCom = 1
$script:ownedPids = @{}
$script:processNames = @{}
$script:controlTypes = $null
$script:allowPatterns = @()
$script:MaxRefs = 20000
$script:MaxComHandles = 2000

# HRESULTs that mean the COM server (or the RPC connection to it) is gone: 0x800706BA RPC server unavailable,
# 0x800706BE RPC call failed, 0x800706BF call failed (did not execute), 0x80010108 object disconnected,
# 0x80010007 / 0x80010012 server died, 0x800401FD object not connected. Signed 32-bit values.
$script:deadHResults = @(-2147023174, -2147023170, -2147023169, -2147417848, -2147418105, -2147418094, -2147220995)

function Set-Result($value) {
    $script:result = $value
}

function Fail([string]$code, [string]$message) {
    $ex = New-Object System.InvalidOperationException($message)
    $ex.Data['code'] = $code
    throw $ex
}

function Send-Reply($rid, [bool]$ok, $value, $message, $code) {
    $reply = [ordered]@{ rid = $rid; ok = $ok }
    if ($ok) {
        $reply['value'] = $value
    }
    else {
        $reply['error'] = $message
        $reply['code'] = $code
    }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $reply -Compress -Depth 12))
    [Console]::Out.Flush()
}

function Get-Prop($object, [string]$name) {
    if ($null -eq $object) { return $null }
    $p = $object.PSObject.Properties[$name]
    if ($null -eq $p) { return $null }
    # The unary comma keeps an array (or a COM collection) in one piece: a function's output is otherwise unrolled.
    return ,$p.Value
}

function Get-IntArg($value, [int]$default) {
    if ($null -eq $value) { return $default }
    return [int]$value
}

function Read-AllowList {
    $raw = $AllowProgIds
    if ([string]::IsNullOrEmpty($raw)) { $raw = 'SASEGObjectModel.Application.*,SASObjectManager.*' }
    $list = New-Object System.Collections.ArrayList
    foreach ($item in ($raw -split '[,;]')) {
        $pattern = $item.Trim()
        if ($pattern.Length -eq 0) { continue }
        if ($pattern -notmatch '^[A-Za-z0-9_.*]+$') {
            [Console]::Error.WriteLine('ignoring an invalid ProgID pattern in -AllowProgIds (only letters, digits, _ . * are allowed)')
            continue
        }
        [void]$list.Add($pattern)
    }
    $script:allowPatterns = $list.ToArray()
}

function Test-ProgIdAllowed([string]$progId) {
    if ($progId -notmatch '^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$') { return $false }
    foreach ($pattern in $script:allowPatterns) {
        if ($progId -like $pattern) { return $true }
    }
    return $false
}

# ---- UI Automation: elements and handles ---------------------------------------------------------------------------
function Get-AutomationRoot {
    return [System.Windows.Automation.AutomationElement]::RootElement
}

function Get-TypeName($controlType) {
    if ($null -eq $controlType) { return '' }
    return ([string]$controlType.ProgrammaticName) -replace '^ControlType\.', ''
}

function Get-ControlTypeByName([string]$name) {
    if ($null -eq $script:controlTypes) {
        $map = @{}
        $fields = [System.Windows.Automation.ControlType].GetFields([System.Reflection.BindingFlags]'Public,Static')
        foreach ($f in $fields) {
            if ($f.FieldType -eq [System.Windows.Automation.ControlType]) {
                $map[$f.Name.ToLowerInvariant()] = $f.GetValue($null)
            }
        }
        $script:controlTypes = $map
    }
    $key = ($name -replace '^ControlType\.', '').ToLowerInvariant()
    if (-not $script:controlTypes.ContainsKey($key)) {
        Fail 'ERROR' ('unknown control type "' + $name + '" (Button, Edit, Tree, TreeItem, Window, ...)')
    }
    return $script:controlTypes[$key]
}

function Get-Ref($el) {
    $key = ''
    try { $key = (($el.GetRuntimeId()) -join '-') } catch { $key = '' }
    if ($key.Length -gt 0 -and $script:keyToRef.ContainsKey($key)) {
        $existing = [string]$script:keyToRef[$key]
        $script:refToElement[$existing] = $el
        return $existing
    }
    if ($script:refToElement.Count -ge $script:MaxRefs) {
        # Every handle becomes NOT_FOUND; the TypeScript locators resolve again. Bounded memory beats a leak.
        $script:refToElement = @{}
        $script:keyToRef = @{}
    }
    $ref = 'e' + $script:nextRef
    $script:nextRef++
    $script:refToElement[$ref] = $el
    if ($key.Length -gt 0) { $script:keyToRef[$key] = $ref }
    return $ref
}

function Get-El([string]$ref) {
    if ([string]::IsNullOrEmpty($ref) -or -not $script:refToElement.ContainsKey($ref)) {
        Fail 'NOT_FOUND' ('unknown element handle "' + $ref + '" (the control was closed or the tree was rebuilt)')
    }
    $el = $script:refToElement[$ref]
    try {
        $null = $el.Current.ProcessId
    }
    catch {
        $script:refToElement.Remove($ref)
        Fail 'NOT_FOUND' ('the control "' + $ref + '" is gone (its window was closed or the tree was rebuilt)')
    }
    return $el
}

function Get-RootOrElement($ref) {
    if ([string]::IsNullOrEmpty([string]$ref)) { return (Get-AutomationRoot) }
    return (Get-El ([string]$ref))
}

function Get-Pattern($el, $pattern) {
    $obj = $null
    if ($el.TryGetCurrentPattern($pattern, [ref]$obj)) { return $obj }
    return $null
}

function Get-PatternNames($el) {
    $names = New-Object System.Collections.ArrayList
    try {
        foreach ($p in $el.GetSupportedPatterns()) {
            [void]$names.Add((([string]$p.ProgrammaticName) -replace 'PatternIdentifiers\.Pattern$', ''))
        }
    }
    catch { }
    return ,$names
}

function Test-IsPassword($el) {
    try { return [bool]$el.Current.IsPassword } catch { return $false }
}

# The text of a control: its value (ValuePattern), else its text (TextPattern), else its name. NEVER for a password field.
function Get-ElementText($el) {
    if (Test-IsPassword $el) { return '' }
    $vp = Get-Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -ne $vp) { return [string]$vp.Current.Value }
    $tp = Get-Pattern $el ([System.Windows.Automation.TextPattern]::Pattern)
    if ($null -ne $tp) { return [string]$tp.DocumentRange.GetText(65536) }
    return [string]$el.Current.Name
}

function Get-RectObject($r) {
    if ($r.IsEmpty) { return $null }
    $values = @($r.X, $r.Y, $r.Width, $r.Height)
    foreach ($v in $values) {
        if ([double]::IsInfinity($v) -or [double]::IsNaN($v)) { return $null }
    }
    return [ordered]@{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
}

function Convert-Element($el, [bool]$full) {
    $c = $el.Current
    $isPwd = Test-IsPassword $el
    $o = [ordered]@{
        ref          = (Get-Ref $el)
        name         = [string]$c.Name
        automationId = [string]$c.AutomationId
        controlType  = (Get-TypeName $c.ControlType)
        className    = [string]$c.ClassName
        enabled      = [bool]$c.IsEnabled
        offscreen    = [bool]$c.IsOffscreen
        isPassword   = $isPwd
        pid          = [int]$c.ProcessId
    }
    $rect = Get-RectObject $c.BoundingRectangle
    if ($null -ne $rect) { $o['rect'] = $rect }
    if (-not $full) { return $o }

    $o['focused'] = [bool]$c.HasKeyboardFocus
    $o['patterns'] = (Get-PatternNames $el)
    $vp = Get-Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -ne $vp) {
        if ($isPwd) { $o['value'] = '' } else { $o['value'] = [string]$vp.Current.Value }
    }
    $tg = Get-Pattern $el ([System.Windows.Automation.TogglePattern]::Pattern)
    if ($null -ne $tg) { $o['toggleState'] = [string]$tg.Current.ToggleState }
    $si = Get-Pattern $el ([System.Windows.Automation.SelectionItemPattern]::Pattern)
    if ($null -ne $si) { $o['selected'] = [bool]$si.Current.IsSelected }
    $ec = Get-Pattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    if ($null -ne $ec) { $o['expandState'] = [string]$ec.Current.ExpandCollapseState }
    return $o
}

function Get-ProcessName([int]$processId) {
    if ($script:processNames.ContainsKey($processId)) { return [string]$script:processNames[$processId] }
    $name = ''
    try { $name = [System.Diagnostics.Process]::GetProcessById($processId).ProcessName } catch { $name = '' }
    $script:processNames[$processId] = $name
    return $name
}

function Convert-Window($el) {
    $o = Convert-Element $el $false
    $o['process'] = (Get-ProcessName ([int]$o['pid']))
    $o['hwnd'] = [long]$el.Current.NativeWindowHandle
    return $o
}

function Get-TopWindowElements {
    $root = Get-AutomationRoot
    return ,$root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
}

function Test-WindowFilter($el, $filter) {
    $c = $el.Current
    $wantPid = Get-Prop $filter 'pid'
    if ($null -ne $wantPid -and [int]$c.ProcessId -ne [int]$wantPid) { return $false }
    $wantProcess = Get-Prop $filter 'processName'
    if ($null -ne $wantProcess) {
        $actual = Get-ProcessName ([int]$c.ProcessId)
        $wanted = ([string]$wantProcess) -replace '\.exe$', ''
        if ($actual -ne $wanted -and $actual.ToLowerInvariant() -ne $wanted.ToLowerInvariant()) { return $false }
    }
    $wantTitle = Get-Prop $filter 'titleRegex'
    if ($null -ne $wantTitle) {
        $rx = New-Object System.Text.RegularExpressions.Regex([string]$wantTitle, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if (-not $rx.IsMatch([string]$c.Name)) { return $false }
    }
    return $true
}

function Get-WindowList($filter) {
    $list = New-Object System.Collections.ArrayList
    foreach ($el in (Get-TopWindowElements)) {
        try {
            if (Test-WindowFilter $el $filter) { [void]$list.Add((Convert-Window $el)) }
        }
        catch { }
    }
    return ,$list
}

function Get-TopLevelOf($el) {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $root = Get-AutomationRoot
    $current = $el
    for ($i = 0; $i -lt 64; $i++) {
        $parent = $walker.GetParent($current)
        if ($null -eq $parent) { return $current }
        if ([System.Windows.Automation.Automation]::Compare($parent, $root)) { return $current }
        $current = $parent
    }
    return $current
}

function Get-ClickPoint($el) {
    $pt = New-Object System.Windows.Point
    if ($el.TryGetClickablePoint([ref]$pt)) { return $pt }
    $r = $el.Current.BoundingRectangle
    if (-not $r.IsEmpty -and $r.Width -gt 0 -and $r.Height -gt 0) {
        return (New-Object System.Windows.Point(($r.X + ($r.Width / 2)), ($r.Y + ($r.Height / 2))))
    }
    Fail 'ERROR' 'the control has no clickable point (it is off-screen, collapsed or hidden)'
}

function Invoke-MouseClick($el, [bool]$right, [int]$count) {
    $top = Get-TopLevelOf $el
    [SasWin]::Foreground([long]$top.Current.NativeWindowHandle)
    $pt = Get-ClickPoint $el
    [SasWin]::MouseClick([int]$pt.X, [int]$pt.Y, $right, $count)
}

# ---- find ----------------------------------------------------------------------------------------------------------
function Join-Conditions($conditions) {
    if ($conditions.Count -eq 0) { return [System.Windows.Automation.Condition]::TrueCondition }
    $combined = $conditions[0]
    for ($i = 1; $i -lt $conditions.Count; $i++) {
        $combined = New-Object System.Windows.Automation.AndCondition($combined, $conditions[$i])
    }
    return $combined
}

function Get-FindCondition($c) {
    $conditions = New-Object System.Collections.ArrayList
    $name = Get-Prop $c 'name'
    if ($null -ne $name) {
        [void]$conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, [string]$name)))
    }
    $id = Get-Prop $c 'automationId'
    if ($null -ne $id) {
        [void]$conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$id)))
    }
    $type = Get-Prop $c 'controlType'
    if ($null -ne $type) {
        [void]$conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, (Get-ControlTypeByName ([string]$type)))))
    }
    $class = Get-Prop $c 'className'
    if ($null -ne $class) {
        [void]$conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, [string]$class)))
    }
    return (Join-Conditions $conditions)
}

function Test-FindExtra($el, $c) {
    $cur = $el.Current
    $contains = Get-Prop $c 'nameContains'
    if ($null -ne $contains) {
        if (([string]$cur.Name).IndexOf([string]$contains, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
    }
    $nameRegex = Get-Prop $c 'nameRegex'
    if ($null -ne $nameRegex) {
        $options = [System.Text.RegularExpressions.RegexOptions]::None
        if ((Get-Prop $nameRegex 'ignoreCase') -eq $true) { $options = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase }
        $rx = New-Object System.Text.RegularExpressions.Regex([string](Get-Prop $nameRegex 'pattern'), $options)
        if (-not $rx.IsMatch([string]$cur.Name)) { return $false }
    }
    if ((Get-Prop $c 'visibleOnly') -eq $true -and $cur.IsOffscreen) { return $false }
    $text = Get-Prop $c 'text'
    if ($null -ne $text) {
        $actual = Get-ElementText $el
        if ($actual.IndexOf([string]$text, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
    }
    return $true
}

# ---- operations: protocol and windows -----------------------------------------------------------------------------
function Op-Ping($cmd) {
    Set-Result ([ordered]@{
            bridge       = 'sas-desktop-bridge'
            version      = $script:BridgeVersion
            powershell   = $PSVersionTable.PSVersion.ToString()
            is64BitProcess = [Environment]::Is64BitProcess
            pid          = $PID
        })
}

function Op-Windows($cmd) {
    Set-Result (Get-WindowList $cmd)
}

function Join-ProcessArguments($items) {
    $parts = New-Object System.Collections.ArrayList
    foreach ($item in @($items)) {
        $text = [string]$item
        if ($text.Length -eq 0 -or $text -match '[\s"]') {
            $text = '"' + ($text -replace '"', '\"') + '"'
        }
        [void]$parts.Add($text)
    }
    return ($parts.ToArray() -join ' ')
}

function Op-Launch($cmd) {
    $path = [string](Get-Prop $cmd 'path')
    if ([string]::IsNullOrEmpty($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Fail 'ERROR' ('the program to launch does not exist: ' + $path)
    }
    $before = @{}
    foreach ($w in (Get-TopWindowElements)) {
        try { $before[[string]$w.Current.NativeWindowHandle] = $true } catch { }
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $path
    $psi.Arguments = Join-ProcessArguments (Get-Prop $cmd 'args')
    $cwd = Get-Prop $cmd 'cwd'
    if ($null -ne $cwd) { $psi.WorkingDirectory = [string]$cwd }
    $psi.UseShellExecute = $true
    $started = [System.Diagnostics.Process]::Start($psi)
    if ($null -ne $started) { $script:ownedPids[[int]$started.Id] = $true }

    $wait = Get-Prop $cmd 'waitForWindow'
    if ($null -eq $wait) {
        $startedPid = 0
        if ($null -ne $started) { $startedPid = [int]$started.Id }
        Set-Result ([ordered]@{ pid = $startedPid; process = (Get-ProcessName $startedPid) })
        return
    }
    $regex = Get-Prop $wait 'titleRegex'
    $timeoutMs = Get-IntArg (Get-Prop $wait 'timeoutMs') 60000
    $deadline = (Get-Date).AddMilliseconds($timeoutMs)
    while ((Get-Date) -lt $deadline) {
        foreach ($el in (Get-TopWindowElements)) {
            try {
                if ($before.ContainsKey([string]$el.Current.NativeWindowHandle)) { continue }
                $matchesPid = ($null -ne $started -and [int]$el.Current.ProcessId -eq [int]$started.Id)
                $matchesTitle = $false
                if ($null -ne $regex) {
                    $rx = New-Object System.Text.RegularExpressions.Regex([string]$regex, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
                    $matchesTitle = $rx.IsMatch([string]$el.Current.Name)
                }
                if ($null -ne $regex) { $isCandidate = $matchesTitle } else { $isCandidate = $matchesPid }
                if ($isCandidate) {
                    $window = Convert-Window $el
                    $script:ownedPids[[int]$window['pid']] = $true
                    Set-Result ([ordered]@{ pid = $window['pid']; process = $window['process']; window = $window })
                    return
                }
            }
            catch { }
        }
        Start-Sleep -Milliseconds 250
    }
    Fail 'NOT_FOUND' ('the program started but no window appeared within ' + $timeoutMs + ' ms' + $(if ($null -ne $regex) { ' (title matching ' + $regex + ')' } else { '' }))
}

function Op-Attach($cmd) {
    $list = Get-WindowList $cmd
    $best = $null
    foreach ($w in $list) {
        if ([string]$w['name'] -ne '' -and -not [bool]$w['offscreen']) { $best = $w; break }
    }
    if ($null -eq $best) {
        foreach ($w in $list) { if ([string]$w['name'] -ne '') { $best = $w; break } }
    }
    if ($null -eq $best) { Fail 'NOT_FOUND' 'no top-level window matches (is the application running in this desktop session?)' }
    $script:ownedPids[[int]$best['pid']] = $true
    Set-Result ([ordered]@{ pid = $best['pid']; process = $best['process']; window = $best })
}

function Op-Find($cmd) {
    $root = Get-RootOrElement (Get-Prop $cmd 'root')
    $c = Get-Prop $cmd 'criteria'
    $scope = [System.Windows.Automation.TreeScope]::Descendants
    if ((Get-Prop $c 'scope') -eq 'children') { $scope = [System.Windows.Automation.TreeScope]::Children }
    $limit = Get-IntArg (Get-Prop $cmd 'limit') 50
    $nth = Get-Prop $c 'nth'
    $found = $root.FindAll($scope, (Get-FindCondition $c))
    $out = New-Object System.Collections.ArrayList
    $seen = 0
    foreach ($el in $found) {
        try {
            if (-not (Test-FindExtra $el $c)) { continue }
            if ($null -ne $nth) {
                if ($seen -eq [int]$nth) { [void]$out.Add((Convert-Element $el $false)); break }
                $seen++
                continue
            }
            [void]$out.Add((Convert-Element $el $false))
            if ($out.Count -ge $limit) { break }
        }
        catch { }
    }
    Set-Result $out
}

function Op-Children($cmd) {
    $el = Get-El ([string](Get-Prop $cmd 'ref'))
    $out = New-Object System.Collections.ArrayList
    foreach ($kid in $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
        try { [void]$out.Add((Convert-Element $kid $false)) } catch { }
    }
    Set-Result $out
}

function Op-Info($cmd) {
    $el = Get-El ([string](Get-Prop $cmd 'ref'))
    Set-Result (Convert-Element $el $true)
}

function Op-GetText($cmd) {
    $el = Get-El ([string](Get-Prop $cmd 'ref'))
    Set-Result (Get-ElementText $el)
}

# ---- operations: acting --------------------------------------------------------------------------------------------
function Op-Invoke($cmd) {
    $el = Get-El ([string](Get-Prop $cmd 'ref'))
    $ip = Get-Pattern $el ([System.Windows.Automation.InvokePattern]::Pattern)
    if ($null -eq $ip) { Fail 'ERROR' 'the control does not support the Invoke pattern (use click)' }
    Set-Result ([SasInvoke]::Run($ip, 400))
}

function Op-Click($cmd) {
    $el = Get-El ([string](Get-Prop $cmd 'ref'))
    $ip = Get-Pattern $el ([System.Windows.Automation.InvokePattern]::Pattern)
    if ($null -ne $ip) {
        Set-Result ([SasInvoke]::Run($ip, 400))
        return
    }
    Invoke-MouseClick $el $false 1
    Set-Result 'mouse'
}

function Op-DoubleClick($cmd) {
    $el = Get-El ([string](Get-Prop $cmd 'ref'))
    Invoke-MouseClick $el $false 2
    Set-Result 'mouse'
}

function Op-RightClick($cmd) {
    $el = Get-El ([string](Get-Prop $cmd 'ref'))
    Invoke-MouseClick $el $true 1
    Set-Result 'mouse'
}

function Op-SetText($cmd) {
    $el = Get-El ([string](Get-Prop $cmd 'ref'))
    $text = [string](Get-Prop $cmd 'text')
    $vp = Get-Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -ne $vp -and -not $vp.Current.IsReadOnly) {
        $vp.SetValue($text)
        Set-Result 'ValuePattern'
        return
    }
    # Fallback: focus, select everything, type. The text is never echoed anywhere.
    $el.SetFocus()
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    if ($text.Length -eq 0) { [System.Windows.Forms.SendKeys]::SendWait('{DEL}') } else { [SasWin]::TypeText($text) }
    Set-Result 'keyboard'
}

function Op-Select($cmd) {
    $el = Get-El ([string](Get-Prop $cmd 'ref'))
    $si = Get-Pattern $el ([System.Windows.Automation.SelectionItemPattern]::Pattern)
    if ($null -ne $si) {
        if ((Get-Prop $cmd 'add') -eq $true) { $si.AddToSelection() } else { $si.Select() }
        Set-Result 'SelectionItemPattern'
        return
    }
    Invoke-MouseClick $el $false 1
    Set-Result 'mouse'
}

function Op-Expand($cmd) {
    $el = Get-El ([string](Get-Prop $cmd 'ref'))
    $ec = Get-Pattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    if ($null -eq $ec) { Fail 'ERROR' 'the control does not support Expand/Collapse' }
    $ec.Expand()
    Set-Result $null
}

function Op-Collapse($cmd) {
    $el = Get-El ([string](Get-Prop $cmd 'ref'))
    $ec = Get-Pattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    if ($null -eq $ec) { Fail 'ERROR' 'the control does not support Expand/Collapse' }
    $ec.Collapse()
    Set-Result $null
}

function Op-Toggle($cmd) {
    $el = Get-El ([string](Get-Prop $cmd 'ref'))
    $tg = Get-Pattern $el ([System.Windows.Automation.TogglePattern]::Pattern)
    if ($null -eq $tg) { Fail 'ERROR' 'the control does not support the Toggle pattern' }
    $want = Get-Prop $cmd 'state'
    if ($null -eq $want) {
        $tg.Toggle()
    }
    else {
        $target = 'Off'
        if ([bool]$want) { $target = 'On' }
        for ($i = 0; $i -lt 3 -and [string]$tg.Current.ToggleState -ne $target; $i++) { $tg.Toggle() }
    }
    Set-Result ([string]$tg.Current.ToggleState)
}

function Op-ScrollIntoView($cmd) {
    $el = Get-El ([string](Get-Prop $cmd 'ref'))
    $sp = Get-Pattern $el ([System.Windows.Automation.ScrollItemPattern]::Pattern)
    if ($null -ne $sp) { $sp.ScrollIntoView() } else { $el.SetFocus() }
    Set-Result $null
}

function Op-SendKeys($cmd) {
    $ref = Get-Prop $cmd 'ref'
    if (-not [string]::IsNullOrEmpty([string]$ref)) { (Get-El ([string]$ref)).SetFocus() }
    # SendKeys syntax: {ENTER}, {TAB}, ^a (Ctrl+A), %f (Alt+F), +{F10}. Never echoed.
    [System.Windows.Forms.SendKeys]::SendWait([string](Get-Prop $cmd 'keys'))
    Set-Result $null
}

function Op-Focus($cmd) {
    $el = Get-El ([string](Get-Prop $cmd 'ref'))
    $el.SetFocus()
    Set-Result $null
}

function Op-WaitForIdle($cmd) {
    $processId = Get-Prop $cmd 'pid'
    $timeoutMs = Get-IntArg (Get-Prop $cmd 'timeoutMs') 5000
    if ($null -eq $processId) { Set-Result ([ordered]@{ idle = $true }); return }
    $idle = $true
    try {
        $p = [System.Diagnostics.Process]::GetProcessById([int]$processId)
        $exited = $false
        try { $exited = [bool]$p.HasExited } catch { $exited = $false }
        if ($exited) { Fail 'SESSION_LOST' ('the process ' + $processId + ' has exited') }
        $hung = $false
        $filter = New-Object PSObject -Property @{ pid = [int]$processId }
        foreach ($w in (Get-WindowList $filter)) {
            if ([SasWin]::IsHung([long]$w['hwnd'])) { $hung = $true }
        }
        if ($hung) { $idle = $false }
        elseif ($timeoutMs -gt 0) {
            try { $idle = [bool]$p.WaitForInputIdle($timeoutMs) } catch [System.InvalidOperationException] { $idle = $true }
        }
    }
    catch [System.ArgumentException] {
        Fail 'SESSION_LOST' ('there is no process with id ' + $processId)
    }
    Set-Result ([ordered]@{ idle = $idle })
}

# ---- operations: screenshot and tree -------------------------------------------------------------------------------
function Op-Screenshot($cmd) {
    $ref = Get-Prop $cmd 'ref'
    $el = $null
    if ([string]::IsNullOrEmpty([string]$ref)) {
        $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $x = $bounds.X; $y = $bounds.Y; $w = $bounds.Width; $h = $bounds.Height
    }
    else {
        $el = Get-El ([string]$ref)
        $r = $el.Current.BoundingRectangle
        if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { Fail 'ERROR' 'the control has no visible area to take a screenshot of' }
        $x = [int]$r.X; $y = [int]$r.Y; $w = [int]$r.Width; $h = [int]$r.Height
    }
    $bitmap = New-Object System.Drawing.Bitmap($w, $h)
    try {
        $g = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
            # Paint every password field black: what is typed there must not end up in evidence files.
            $scopeEl = $el
            if ($null -eq $scopeEl) { $scopeEl = Get-AutomationRoot }
            $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsPasswordProperty, $true)
            foreach ($pw in $scopeEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)) {
                try {
                    $pr = $pw.Current.BoundingRectangle
                    if (-not $pr.IsEmpty) { $g.FillRectangle([System.Drawing.Brushes]::Black, [int]($pr.X - $x), [int]($pr.Y - $y), [int]$pr.Width, [int]$pr.Height) }
                }
                catch { }
            }
        }
        finally { $g.Dispose() }
        $stream = New-Object System.IO.MemoryStream
        try {
            $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
            Set-Result ([ordered]@{ pngBase64 = [Convert]::ToBase64String($stream.ToArray()); width = $w; height = $h })
        }
        finally { $stream.Dispose() }
    }
    finally { $bitmap.Dispose() }
}

function Add-TreeNodes($el, [int]$depth, [int]$maxDepth, [int]$maxNodes, $list) {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $kid = $walker.GetFirstChild($el)
    while ($null -ne $kid) {
        if ($list.Count -ge $maxNodes) { return }
        try {
            $node = Convert-Element $kid $false
            $node['depth'] = $depth
            [void]$list.Add($node)
            if ($depth + 1 -lt $maxDepth) { Add-TreeNodes $kid ($depth + 1) $maxDepth $maxNodes $list }
        }
        catch { }
        $kid = $walker.GetNextSibling($kid)
    }
}

function Op-Tree($cmd) {
    $maxDepth = Get-IntArg (Get-Prop $cmd 'depth') 4
    $maxNodes = Get-IntArg (Get-Prop $cmd 'maxNodes') 400
    $list = New-Object System.Collections.ArrayList
    $ref = Get-Prop $cmd 'ref'
    if ([string]::IsNullOrEmpty([string]$ref)) {
        $filterPid = Get-Prop $cmd 'pid'
        foreach ($el in (Get-TopWindowElements)) {
            if ($list.Count -ge $maxNodes) { break }
            try {
                if ($null -ne $filterPid -and [int]$el.Current.ProcessId -ne [int]$filterPid) { continue }
                $node = Convert-Element $el $false
                $node['depth'] = 0
                [void]$list.Add($node)
                if ($maxDepth -gt 1) { Add-TreeNodes $el 1 $maxDepth $maxNodes $list }
            }
            catch { }
        }
    }
    else {
        Add-TreeNodes (Get-El ([string]$ref)) 0 $maxDepth $maxNodes $list
    }
    Set-Result $list
}

function Op-Close($cmd) {
    $el = Get-El ([string](Get-Prop $cmd 'ref'))
    $wp = Get-Pattern $el ([System.Windows.Automation.WindowPattern]::Pattern)
    if ($null -eq $wp) { Fail 'ERROR' 'the element is not a window (no Window pattern)' }
    $wp.Close()
    Set-Result $null
}

function Op-Kill($cmd) {
    $targets = New-Object System.Collections.ArrayList
    $wantPid = Get-Prop $cmd 'pid'
    $wantName = Get-Prop $cmd 'processName'
    if ($null -ne $wantPid) { [void]$targets.Add([int]$wantPid) }
    elseif ($null -ne $wantName) {
        $name = ([string]$wantName) -replace '\.exe$', ''
        foreach ($p in [System.Diagnostics.Process]::GetProcessesByName($name)) {
            if ($script:ownedPids.ContainsKey([int]$p.Id)) { [void]$targets.Add([int]$p.Id) }
        }
    }
    else { Fail 'ERROR' 'kill needs a pid or a processName' }
    $killed = 0
    foreach ($t in $targets) {
        if ($t -eq $PID) { Fail 'DENIED' 'refusing to stop the bridge itself' }
        if (-not $script:ownedPids.ContainsKey($t)) {
            Fail 'DENIED' ('refusing to stop process ' + $t + ': this bridge did not launch it or attach to it')
        }
        try {
            [System.Diagnostics.Process]::GetProcessById($t).Kill()
            $killed++
        }
        catch [System.ArgumentException] { }
    }
    Set-Result ([ordered]@{ killed = $killed })
}

# ---- operations: Java diagnosis and environment --------------------------------------------------------------------
function Get-JavaContentCount($el, [int]$cap) {
    # Counts the elements below a window that are not part of its native title bar. A Swing window without the Java
    # Access Bridge has a title bar and nothing else.
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $count = 0
    $queue = New-Object System.Collections.Queue
    $first = $walker.GetFirstChild($el)
    while ($null -ne $first) { $queue.Enqueue($first); $first = $walker.GetNextSibling($first) }
    while ($queue.Count -gt 0 -and $count -lt $cap) {
        $item = $queue.Dequeue()
        try {
            if ((Get-TypeName $item.Current.ControlType) -eq 'TitleBar') { continue }
            $count++
            $kid = $walker.GetFirstChild($item)
            while ($null -ne $kid) { $queue.Enqueue($kid); $kid = $walker.GetNextSibling($kid) }
        }
        catch { }
    }
    return $count
}

function Test-AccessBridgeDll {
    $paths = @((Join-Path $env:SystemRoot 'System32\WindowsAccessBridge-64.dll'), (Join-Path $env:SystemRoot 'SysWOW64\WindowsAccessBridge-32.dll'), (Join-Path $env:SystemRoot 'System32\WindowsAccessBridge-32.dll'))
    foreach ($p in $paths) { if (Test-Path -LiteralPath $p) { return $true } }
    return $false
}

function Test-AccessibilityProperties {
    $file = Join-Path $env:USERPROFILE '.accessibility.properties'
    if (-not (Test-Path -LiteralPath $file)) { return $false }
    try {
        foreach ($line in (Get-Content -LiteralPath $file)) {
            if ($line -match '^\s*assistive_technologies\s*=') { return $true }
        }
    }
    catch { }
    return $false
}

function Op-DiagnoseJava($cmd) {
    $filterPid = Get-Prop $cmd 'pid'
    $windows = New-Object System.Collections.ArrayList
    foreach ($el in (Get-TopWindowElements)) {
        try {
            $c = $el.Current
            if ($null -ne $filterPid -and [int]$c.ProcessId -ne [int]$filterPid) { continue }
            $processName = Get-ProcessName ([int]$c.ProcessId)
            $isJava = (([string]$c.ClassName) -like 'SunAwt*') -or (@('java', 'javaw', 'sasmc') -contains $processName.ToLowerInvariant())
            if (-not $isJava) { continue }
            $content = Get-JavaContentCount $el 60
            [void]$windows.Add([ordered]@{
                    title                = [string]$c.Name
                    pid                  = [int]$c.ProcessId
                    process              = $processName
                    className            = [string]$c.ClassName
                    isJava               = $true
                    elementCount         = $content
                    suspectedBridgeMissing = ($content -lt 3)
                })
        }
        catch { }
    }
    Set-Result ([ordered]@{
            windows                 = $windows
            accessBridgeDll         = (Test-AccessBridgeDll)
            accessibilityProperties = (Test-AccessibilityProperties)
        })
}

function Find-JabSwitch {
    $found = New-Object System.Collections.ArrayList
    $candidates = New-Object System.Collections.ArrayList
    if ($env:JAVA_HOME) { [void]$candidates.Add((Join-Path $env:JAVA_HOME 'bin\jabswitch.exe')) }
    foreach ($pf in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $pf) { continue }
        foreach ($sub in @('SASHome\SASPrivateJavaRuntimeEnvironment', 'Java')) {
            $base = Join-Path $pf $sub
            if (Test-Path -LiteralPath $base) {
                foreach ($hit in (Get-ChildItem -LiteralPath $base -Filter 'jabswitch.exe' -Recurse -ErrorAction SilentlyContinue)) {
                    [void]$candidates.Add($hit.FullName)
                }
            }
        }
    }
    foreach ($c in $candidates) {
        if ((Test-Path -LiteralPath $c) -and -not ($found -contains $c)) { [void]$found.Add($c) }
    }
    return ,$found
}

function Op-Environment($cmd) {
    $uiaOk = $false
    $windowCount = 0
    try {
        $windowCount = (Get-TopWindowElements).Count
        $uiaOk = $true
    }
    catch { $uiaOk = $false }
    $elevated = $false
    try { $elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { }
    Set-Result ([ordered]@{
            powershell          = $PSVersionTable.PSVersion.ToString()
            is64BitProcess      = [Environment]::Is64BitProcess
            is64BitOS           = [Environment]::Is64BitOperatingSystem
            os                  = [Environment]::OSVersion.VersionString
            userInteractive     = [Environment]::UserInteractive
            sessionName         = [string]$env:SESSIONNAME
            desktopAccessible   = [SasWin]::DesktopAccessible()
            uiaAvailable        = $uiaOk
            topLevelWindows     = $windowCount
            elevated            = $elevated
            accessBridgeDll     = (Test-AccessBridgeDll)
            accessibilityProperties = (Test-AccessibilityProperties)
            jabswitch           = (Find-JabSwitch)
            allowedProgIds      = $script:allowPatterns
        })
}

# ---- operations: COM -----------------------------------------------------------------------------------------------
function Get-ComException($ex) {
    while ($null -ne $ex) {
        if ($ex -is [System.Runtime.InteropServices.COMException]) { return $ex }
        $ex = $ex.InnerException
    }
    return $null
}

function Get-InnerMessage($ex) {
    while ($null -ne $ex.InnerException) { $ex = $ex.InnerException }
    return [string]$ex.Message
}

function Register-ComObject($obj) {
    if ($script:comHandles.Count -ge $script:MaxComHandles) {
        Fail 'ERROR' ('too many open COM objects (' + $script:MaxComHandles + '): release the ones you no longer need with com.release')
    }
    $handle = 'o' + $script:nextCom
    $script:nextCom++
    $script:comHandles[$handle] = $obj
    return $handle
}

function Get-ComObject([string]$handle) {
    if ([string]::IsNullOrEmpty($handle) -or -not $script:comHandles.ContainsKey($handle)) {
        Fail 'NOT_FOUND' ('unknown COM object handle "' + $handle + '" (released, or never created by this bridge)')
    }
    return ,$script:comHandles[$handle]
}

function Test-IsComObject($value) {
    if ($null -eq $value) { return $false }
    if ($value -is [string] -or $value -is [ValueType]) { return $false }
    return ($value -is [System.__ComObject]) -or $value.GetType().IsCOMObject
}

function Convert-ComOut($value) {
    if ($null -eq $value) { return $null }
    if ($value -is [string] -or $value -is [bool] -or $value -is [int] -or $value -is [long] -or $value -is [double] -or $value -is [single] -or $value -is [int16] -or $value -is [byte] -or $value -is [decimal] -or $value -is [uint32]) { return $value }
    if ($value -is [datetime]) { return $value.ToString('o') }
    if ($value -is [System.Array]) {
        $items = New-Object System.Collections.ArrayList
        foreach ($item in $value) { [void]$items.Add((Convert-ComOut $item)) }
        return ,$items
    }
    if ($value -is [System.Enum]) { return [int]$value }
    if (Test-IsComObject $value) { return [ordered]@{ __com = (Register-ComObject $value) } }
    return [string]$value
}

function Convert-ComIn($value) {
    if ($null -eq $value) { return $null }
    if ($value -is [long] -and $value -ge [int]::MinValue -and $value -le [int]::MaxValue) { return [int]$value }
    $handle = Get-Prop $value '__com'
    if ($null -ne $handle -and $value -isnot [string]) { return ,(Get-ComObject ([string]$handle)) }
    if ($value -is [System.Array]) {
        $items = New-Object System.Collections.ArrayList
        foreach ($item in $value) { [void]$items.Add((Convert-ComIn $item)) }
        return ,$items.ToArray()
    }
    return $value
}

function Get-ComArguments($raw) {
    if ($null -eq $raw) { return $null }
    $items = New-Object System.Collections.ArrayList
    foreach ($item in @($raw)) { [void]$items.Add((Convert-ComIn $item)) }
    if ($items.Count -eq 0) { return $null }
    return ,([object[]]$items.ToArray())
}

function Invoke-ComMember($target, [string]$name, [string]$kind, $comArgs) {
    $flags = [System.Reflection.BindingFlags]::GetProperty
    if ($kind -eq 'call') { $flags = [System.Reflection.BindingFlags]'InvokeMethod,GetProperty' }
    if ($kind -eq 'set') { $flags = [System.Reflection.BindingFlags]::SetProperty }
    try {
        $member = [System.__ComObject].InvokeMember($name, $flags, $null, $target, $comArgs)
        return ,$member
    }
    catch {
        $com = Get-ComException $_.Exception
        $message = Get-InnerMessage $_.Exception
        if ($null -ne $com) {
            if ($script:deadHResults -contains [int]$com.ErrorCode) {
                Fail 'SESSION_LOST' ('the COM server is gone (HRESULT 0x' + ([int]$com.ErrorCode).ToString('X8') + '): ' + $message)
            }
            Fail 'ERROR' ($message + ' (HRESULT 0x' + ([int]$com.ErrorCode).ToString('X8') + ')')
        }
        Fail 'ERROR' ($name + ': ' + $message)
    }
}

# Walks a dotted path (Projects.Count) from a handle; the last segment is read, written or called by the caller.
function Resolve-ComPath([string]$handle, [string]$path, [bool]$includeLast) {
    $target = Get-ComObject $handle
    if ([string]::IsNullOrEmpty($path)) { return ,$target }
    $segments = $path -split '\.'
    $count = $segments.Count
    if (-not $includeLast) { $count = $count - 1 }
    for ($i = 0; $i -lt $count; $i++) {
        $segment = $segments[$i]
        if ($segment -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { Fail 'ERROR' ('invalid member name "' + $segment + '" in the path') }
        $target = Invoke-ComMember $target $segment 'get' $null
        if ($null -eq $target) { Fail 'ERROR' ('"' + $segment + '" returned nothing: the rest of the path cannot be followed') }
    }
    return ,$target
}

function Op-ComCreate($cmd) {
    $progId = [string](Get-Prop $cmd 'progId')
    if (-not (Test-ProgIdAllowed $progId)) {
        Fail 'DENIED' ('the COM class "' + $progId + '" is not on the allow-list (' + ($script:allowPatterns -join ', ') + '). Configure SAS_COM_PROGIDS to allow it.')
    }
    $type = [System.Type]::GetTypeFromProgID($progId)
    if ($null -eq $type) {
        $bits = '32'
        if ([Environment]::Is64BitProcess) { $bits = '64' }
        Fail 'NOT_FOUND' ('the COM class "' + $progId + '" is not registered for this ' + $bits + '-bit PowerShell. Check the version in the name, and for an older (32-bit) Enterprise Guide start the 32-bit PowerShell (SAS_DESKTOP_POWERSHELL).')
    }
    try {
        $obj = [System.Activator]::CreateInstance($type)
    }
    catch {
        Fail 'ERROR' ('could not create "' + $progId + '": ' + (Get-InnerMessage $_.Exception))
    }
    Set-Result ([ordered]@{ handle = (Register-ComObject $obj) })
}

function Op-ComGet($cmd) {
    $target = Resolve-ComPath ([string](Get-Prop $cmd 'handle')) ([string](Get-Prop $cmd 'path')) $true
    Set-Result (Convert-ComOut $target)
}

function Op-ComSet($cmd) {
    $path = [string](Get-Prop $cmd 'path')
    if ([string]::IsNullOrEmpty($path)) { Fail 'ERROR' 'com.set needs a property path' }
    $target = Resolve-ComPath ([string](Get-Prop $cmd 'handle')) $path $false
    $last = ($path -split '\.')[-1]
    $value = Convert-ComIn (Get-Prop $cmd 'value')
    $null = Invoke-ComMember $target $last 'set' ([object[]]@(, $value))
    Set-Result $null
}

function Op-ComCall($cmd) {
    $method = [string](Get-Prop $cmd 'method')
    if ([string]::IsNullOrEmpty($method)) { Fail 'ERROR' 'com.call needs a method name' }
    $target = Resolve-ComPath ([string](Get-Prop $cmd 'handle')) $method $false
    $last = ($method -split '\.')[-1]
    if ($last -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { Fail 'ERROR' ('invalid method name "' + $last + '"') }
    $out = Invoke-ComMember $target $last 'call' (Get-ComArguments (Get-Prop $cmd 'args'))
    Set-Result (Convert-ComOut $out)
}

function Op-ComRelease($cmd) {
    $handle = [string](Get-Prop $cmd 'handle')
    if ($script:comHandles.ContainsKey($handle)) {
        $obj = $script:comHandles[$handle]
        $script:comHandles.Remove($handle)
        try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($obj) } catch { }
    }
    Set-Result $null
}

# Lists the registered ProgIDs that match the allow-list (and the optional prefix): how the Enterprise Guide version is discovered.
function Op-ComList($cmd) {
    $prefix = [string](Get-Prop $cmd 'prefix')
    if ($prefix -ne '' -and $prefix -notmatch '^[A-Za-z0-9_.]+$') { Fail 'ERROR' 'the prefix may only contain letters, digits, _ and .' }
    $names = New-Object System.Collections.ArrayList
    foreach ($name in [Microsoft.Win32.Registry]::ClassesRoot.GetSubKeyNames()) {
        if ($prefix -ne '' -and -not $name.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        if (Test-ProgIdAllowed $name) { [void]$names.Add($name) }
    }
    $names.Sort()
    Set-Result $names
}

function Release-AllComObjects {
    foreach ($key in @($script:comHandles.Keys)) {
        try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($script:comHandles[$key]) } catch { }
    }
    $script:comHandles = @{}
}

# ---- operations: the recorder (ADR 0002) ---------------------------------------------------------------------------
# NOT VERIFIED on Windows. record.start {pid | processName | titleRegex, mode, maxQueue, secretPatterns, stopKey} starts recording ONE chosen
# program (it refuses without a target); record.events {drain} returns the queued events; record.stop returns the rest and removes the hooks.
function Op-NotImplemented([string]$op) {
    Fail 'NOT_IMPLEMENTED' ('"' + $op + '" is not available in this bridge: ' + [string]$script:RecorderError)
}

function Initialize-Recorder([string]$op) {
    if ($script:RecorderLoaded) { return }
    if ($null -ne $script:RecorderError) { Op-NotImplemented $op }
    try {
        $references = @($uiaReferences) + @([System.Diagnostics.Process].Assembly.Location)
        Add-Type -TypeDefinition $recorderSource -Language CSharp -ReferencedAssemblies $references
        $script:RecorderLoaded = $true
    }
    catch {
        $script:RecorderError = 'the recorder could not be compiled on this machine: ' + (Get-InnerMessage $_.Exception)
        Op-NotImplemented $op
    }
}

function Op-RecordStart($cmd) {
    Initialize-Recorder 'record.start'
    $hasTarget = ($null -ne (Get-Prop $cmd 'pid')) -or ($null -ne (Get-Prop $cmd 'processName')) -or ($null -ne (Get-Prop $cmd 'titleRegex'))
    if (-not $hasTarget) { Fail 'ERROR' 'record.start needs a target - a pid, a processName or a titleRegex: the recorder never records without a chosen program' }
    $mode = [string](Get-Prop $cmd 'mode')
    if ([string]::IsNullOrEmpty($mode)) { $mode = 'full' }
    if ($mode -ne 'full' -and $mode -ne 'uia') { Fail 'ERROR' ('record.start: mode must be full or uia (found "' + $mode + '")') }
    $maxQueue = Get-IntArg (Get-Prop $cmd 'maxQueue') 5000
    if ($maxQueue -lt 1) { Fail 'ERROR' 'record.start: maxQueue must be a positive whole number' }
    $pids = New-Object System.Collections.ArrayList
    $first = $null
    $count = 0
    foreach ($w in (Get-WindowList $cmd)) {
        if ([string]$w['name'] -eq '') { continue }
        if ($null -eq $first) { $first = $w }
        $count++
        if (-not $pids.Contains([int]$w['pid'])) { [void]$pids.Add([int]$w['pid']) }
    }
    if ($null -eq $first) { Fail 'NOT_FOUND' 'record.start: no window of the chosen program is open - start the program first, then the recorder' }
    $patterns = New-Object System.Collections.ArrayList
    foreach ($pattern in @(Get-Prop $cmd 'secretPatterns')) {
        if ($null -ne $pattern -and ([string]$pattern).Length -gt 0) { [void]$patterns.Add([string]$pattern) }
    }
    $stopKey = [string](Get-Prop $cmd 'stopKey')
    try {
        $started = [SasRecorder]::Start([int[]]$pids.ToArray(), $mode, $maxQueue, [string[]]$patterns.ToArray(), $stopKey)
    }
    catch {
        Fail 'ERROR' (Get-InnerMessage $_.Exception)
    }
    Set-Result ([ordered]@{
            pid       = $first['pid']
            pids      = $pids
            process   = $first['process']
            windows   = $count
            mode      = $mode
            startedAt = [string]$started['startedAt']
            maxQueue  = $maxQueue
        })
}

function Op-RecordEvents($cmd) {
    Initialize-Recorder 'record.events'
    $drain = $true
    if ((Get-Prop $cmd 'drain') -eq $false) { $drain = $false }
    try {
        Set-Result ([SasRecorder]::Snapshot($drain))
    }
    catch {
        Fail 'ERROR' (Get-InnerMessage $_.Exception)
    }
}

function Op-RecordStop($cmd) {
    if (-not $script:RecorderLoaded -and $null -eq $script:RecorderError) {
        # nothing was ever started: there is nothing to stop (and nothing to compile for it)
        Set-Result ([ordered]@{ events = @(); dropped = 0; secretKeysDiscarded = 0; foreignKeysIgnored = 0; recording = $false; targetAlive = $false; stopRequested = $false; queued = 0; durationMs = 0 })
        return
    }
    Initialize-Recorder 'record.stop'
    Set-Result ([SasRecorder]::Stop())
}

# Called when the bridge ends (also after an error): the hooks and the UI Automation handlers are removed whatever happened.
function Stop-RecorderQuietly {
    if (-not $script:RecorderLoaded) { return }
    try { $null = [SasRecorder]::Stop() } catch { }
}

# ---- dispatch ------------------------------------------------------------------------------------------------------
function Invoke-Op($cmd) {
    $script:result = $null
    # BEGIN-DISPATCH (tests/desktop/protocol.spec.ts reads the labels below and compares them with DESKTOP_OPS)
    switch -CaseSensitive ([string]$cmd.op) {
        'ping' { Op-Ping $cmd }
        'windows' { Op-Windows $cmd }
        'launch' { Op-Launch $cmd }
        'attach' { Op-Attach $cmd }
        'find' { Op-Find $cmd }
        'children' { Op-Children $cmd }
        'info' { Op-Info $cmd }
        'invoke' { Op-Invoke $cmd }
        'click' { Op-Click $cmd }
        'doubleClick' { Op-DoubleClick $cmd }
        'rightClick' { Op-RightClick $cmd }
        'setText' { Op-SetText $cmd }
        'getText' { Op-GetText $cmd }
        'select' { Op-Select $cmd }
        'expand' { Op-Expand $cmd }
        'collapse' { Op-Collapse $cmd }
        'toggle' { Op-Toggle $cmd }
        'scrollIntoView' { Op-ScrollIntoView $cmd }
        'sendKeys' { Op-SendKeys $cmd }
        'focus' { Op-Focus $cmd }
        'waitForIdle' { Op-WaitForIdle $cmd }
        'screenshot' { Op-Screenshot $cmd }
        'tree' { Op-Tree $cmd }
        'close' { Op-Close $cmd }
        'kill' { Op-Kill $cmd }
        'diagnoseJava' { Op-DiagnoseJava $cmd }
        'environment' { Op-Environment $cmd }
        'com.create' { Op-ComCreate $cmd }
        'com.get' { Op-ComGet $cmd }
        'com.set' { Op-ComSet $cmd }
        'com.call' { Op-ComCall $cmd }
        'com.release' { Op-ComRelease $cmd }
        'com.list' { Op-ComList $cmd }
        'record.start' { Op-RecordStart $cmd }
        'record.stop' { Op-RecordStop $cmd }
        'record.events' { Op-RecordEvents $cmd }
        'quit' { Set-Result $null }
        default { Fail 'ERROR' ('unknown operation "' + [string]$cmd.op + '"') }
    }
    # END-DISPATCH
}

function Get-ErrorCode($ex) {
    $code = $null
    try { $code = $ex.Data['code'] } catch { }
    if ($null -ne $code) { return [string]$code }
    if ($ex -is [System.Windows.Automation.ElementNotAvailableException]) { return 'NOT_FOUND' }
    if (-not [SasWin]::DesktopAccessible()) { return 'SESSION_LOST' }
    return 'ERROR'
}

function Get-ErrorMessage($ex, [string]$code) {
    if ($code -eq 'SESSION_LOST' -and $null -eq $ex.Data['code']) {
        return 'the desktop is locked or the session is disconnected: UI Automation needs an unlocked, connected interactive session'
    }
    $message = [string]$ex.Message
    if ($ex -is [System.Windows.Automation.ElementNotAvailableException]) { return 'the control is gone (its window was closed or the tree was rebuilt)' }
    return $message
}

# ---- main loop -----------------------------------------------------------------------------------------------------
Read-AllowList
Send-Reply 0 $true 'ready' $null $null

try {
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }
        if ($line.Trim().Length -eq 0) { continue }
        $rid = -1
        $op = ''
        try {
            $cmd = ConvertFrom-Json -InputObject $line
            $rid = $cmd.rid
            $op = [string]$cmd.op
            $null = Invoke-Op $cmd
            Send-Reply $rid $true $script:result $null $null
        }
        catch {
            $code = Get-ErrorCode $_.Exception
            Send-Reply $rid $false $null (Get-ErrorMessage $_.Exception $code) $code
        }
        if ($op -eq 'quit') { break }
    }
}
finally {
    Stop-RecorderQuietly
}

Release-AllComObjects
