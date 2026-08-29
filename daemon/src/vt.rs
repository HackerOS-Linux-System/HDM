use tracing::warn;

/// Switch to a virtual terminal
pub fn switch_to(vt: u8) -> Result<(), String> {
    // ioctl VT_ACTIVATE
    use std::os::unix::io::AsRawFd;

    let fd = match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty0")
    {
        Ok(f) => f,
        Err(e) => return Err(format!("Cannot open /dev/tty0: {}", e)),
    };

    // VT_ACTIVATE = 0x5606, VT_WAITACTIVE = 0x5607
    const VT_ACTIVATE: u64 = 0x5606;
    const VT_WAITACTIVE: u64 = 0x5607;

    let result = unsafe { libc::ioctl(fd.as_raw_fd(), VT_ACTIVATE, vt as i32) };

    if result != 0 {
        return Err(format!(
            "VT_ACTIVATE failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    let result = unsafe { libc::ioctl(fd.as_raw_fd(), VT_WAITACTIVE, vt as i32) };

    if result != 0 {
        warn!("VT_WAITACTIVE warning: {}", std::io::Error::last_os_error());
    }

    Ok(())
}

/// Get current VT number
#[allow(dead_code)]
pub fn current_vt() -> Option<u8> {
    use std::os::unix::io::AsRawFd;

    #[repr(C)]
    struct VtStat {
        v_active: u16,
        v_signal: u16,
        v_state: u16,
    }

    let fd = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty0")
        .ok()?;

    const VT_GETSTATE: u64 = 0x5603;
    let mut stat = VtStat {
        v_active: 0,
        v_signal: 0,
        v_state: 0,
    };

    let result = unsafe { libc::ioctl(fd.as_raw_fd(), VT_GETSTATE, &mut stat as *mut VtStat) };

    if result == 0 {
        Some(stat.v_active as u8)
    } else {
        None
    }
}
