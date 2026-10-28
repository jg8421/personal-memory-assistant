param([string]$InstallRoot="$env:LOCALAPPDATA\PersonalMemory",[switch]$ReadOnce)
$ErrorActionPreference='Stop'
# Keep the safety heartbeat responsive; do not alter any system power policy.
[Diagnostics.Process]::GetCurrentProcess().PriorityClass = [Diagnostics.ProcessPriorityClass]::Normal
$mutex=$null
if(-not $ReadOnce){$new=$false;$mutex=[Threading.Mutex]::new($true,'Local\PersonalMemoryCapturePowerPolicy',[ref]$new);if(-not $new){$mutex.Dispose();exit 0}}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;using System.Runtime.InteropServices;using System.Windows.Forms;
public class PMPowerWindow:NativeWindow,IDisposable {
  public int Lid=-1;public bool Registered=false;IntPtr notification;
  public volatile int EffectiveMode=-1;public int EnergySaverStatus=-1;public bool ModeRegistered=false;public bool PowerSaverScheme=false;
  IntPtr modeRegistration;IntPtr saverNotification;IntPtr energyNotification;IntPtr schemeNotification;ModeCallback callback;
  static Guid lid=new Guid("BA3E0F4D-B817-4094-A2D1-D56379E6A0F3");
  static Guid saver=new Guid("E00958C0-C213-4ACE-AC77-FECCED2EEEA5");
  static Guid energy=new Guid("550E8400-E29B-41D4-A716-446655440000");
  static Guid scheme=new Guid("245D8541-3943-4422-B025-13A784F679B7");
  static Guid maxSavings=new Guid("A1841308-3541-4FAB-BC81-F71556F20B4A");
  [StructLayout(LayoutKind.Sequential)] public struct PowerStatus{public byte ACLineStatus,BatteryFlag,BatteryLifePercent,SystemStatusFlag;public int BatteryLifeTime,BatteryFullLifeTime;}
  [DllImport("kernel32.dll")] public static extern bool GetSystemPowerStatus(out PowerStatus s);
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr RegisterPowerSettingNotification(IntPtr h,ref Guid g,uint flags);
  [DllImport("user32.dll")] static extern bool UnregisterPowerSettingNotification(IntPtr h);
  [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void ModeCallback(int mode,IntPtr context);
  [DllImport("powrprof.dll")] static extern int PowerRegisterForEffectivePowerModeNotifications(uint version,ModeCallback callback,IntPtr context,out IntPtr handle);
  [DllImport("powrprof.dll")] static extern int PowerUnregisterFromEffectivePowerModeNotifications(IntPtr handle);
  public PMPowerWindow(){
    CreateHandle(new CreateParams{Caption="PersonalMemoryCapturePower",Parent=new IntPtr(-3)});
    notification=RegisterPowerSettingNotification(Handle,ref lid,0);Registered=notification!=IntPtr.Zero;
    saverNotification=RegisterPowerSettingNotification(Handle,ref saver,0);
    energyNotification=RegisterPowerSettingNotification(Handle,ref energy,0);
    schemeNotification=RegisterPowerSettingNotification(Handle,ref scheme,0);
    callback=delegate(int mode,IntPtr context){EffectiveMode=mode;};
    try{ModeRegistered=PowerRegisterForEffectivePowerModeNotifications(1,callback,IntPtr.Zero,out modeRegistration)==0;}catch(EntryPointNotFoundException){}
  }
  protected override void WndProc(ref Message m){
    if(m.Msg==0x218 && m.WParam.ToInt32()==0x8013){
      Guid g=(Guid)Marshal.PtrToStructure(m.LParam,typeof(Guid));int length=Marshal.ReadInt32(m.LParam,16);
      if(g==lid && length>=4)Lid=Marshal.ReadInt32(m.LParam,20);
      if((g==saver || g==energy) && length>=4)EnergySaverStatus=Marshal.ReadInt32(m.LParam,20);
      if(g==scheme && length>=16)PowerSaverScheme=(Guid)Marshal.PtrToStructure(IntPtr.Add(m.LParam,20),typeof(Guid))==maxSavings;
    }base.WndProc(ref m);
  }
  public PowerStatus ReadPower(){PowerStatus s;GetSystemPowerStatus(out s);return s;}
  public void Dispose(){if(modeRegistration!=IntPtr.Zero)PowerUnregisterFromEffectivePowerModeNotifications(modeRegistration);foreach(IntPtr h in new IntPtr[]{notification,saverNotification,energyNotification,schemeNotification})if(h!=IntPtr.Zero)UnregisterPowerSettingNotification(h);DestroyHandle();}
}
'@
$window=[PMPowerWindow]::new()
$state=Join-Path $InstallRoot 'state\capture-power.json'
[IO.Directory]::CreateDirectory((Split-Path -Parent $state))|Out-Null
$timer=[Windows.Forms.Timer]::new();$timer.Interval=2000
$update={
  $s=$window.ReadPower();$ac=if($s.ACLineStatus -eq 1){$true}elseif($s.ACLineStatus -eq 0){$false}else{$null}
  # Unknown lid on battery pauses conservatively until Windows reports an open lid.
  $paused=($ac -eq $false -and $window.Lid -ne 1) -or ($null -eq $ac)
  $reason=if($ac -eq $true){'ac-connected'}elseif($window.Lid -eq 0){'battery-lid-closed'}elseif($window.Lid -eq 1){'battery-lid-open'}else{'battery-lid-unknown'}
  $batterySaver=$s.SystemStatusFlag -eq 1
  $energySaver=$batterySaver -or $window.EnergySaverStatus -gt 0 -or $window.EffectiveMode -eq 0
  $efficiency=$window.EffectiveMode -eq 1 -or $window.PowerSaverScheme
  $audioPaused=($ac -ne $true) -or $energySaver -or $efficiency -or ($window.ModeRegistered -and $window.EffectiveMode -lt 0)
  $audioReason=if($ac -eq $false){'battery-powered'}elseif($null -eq $ac){'power-source-unknown'}elseif($energySaver -or $efficiency){'energy-saver'}elseif($window.ModeRegistered -and $window.EffectiveMode -lt 0){'power-mode-unknown'}else{'ac-normal'}
  $value=@{checkedAt=(Get-Date).ToUniversalTime().ToString('o');pid=$PID;acConnected=$ac;lidState=$window.Lid;lidNotificationsRegistered=$window.Registered;paused=$paused;reason=$reason;audioPaused=$audioPaused;audioPauseReason=$audioReason;batterySaver=$batterySaver;energySaver=$energySaver;powerEfficiency=$efficiency;effectivePowerMode=$window.EffectiveMode;effectiveModeRegistered=$window.ModeRegistered}|ConvertTo-Json
  try{[IO.File]::WriteAllText(($state+'.tmp'),$value,[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath ($state+'.tmp') -Destination $state -Force}catch{}
  if($ReadOnce){$value}
}
if($ReadOnce){for($probe=0;$probe -lt 20;$probe++){[Windows.Forms.Application]::DoEvents();if($window.EffectiveMode -ge 0){break};Start-Sleep -Milliseconds 50};& $update;$timer.Dispose();$window.Dispose();exit 0}
$timer.Add_Tick($update);& $update;$timer.Start()
try{[Windows.Forms.Application]::Run()}finally{$timer.Stop();$timer.Dispose();$window.Dispose();if($mutex){try{$mutex.ReleaseMutex()}catch{};$mutex.Dispose()}}
