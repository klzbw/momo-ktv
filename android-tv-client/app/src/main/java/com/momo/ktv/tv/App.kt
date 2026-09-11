package com.momo.ktv.tv

import android.app.Application
import android.content.Context
import android.os.Process
import kotlin.system.exitProcess

/**
 * 全局 Application：捕获未处理异常，写入文件，避免"屡次停止运行"。
 * 下次启动时 ServerConfigActivity 会读取并显示崩溃日志。
 */
class App : Application() {
    companion object {
        const val CRASH_FILE = "momo_crash_log.txt"
        var crashLog: String? = null
            private set
    }

    override fun onCreate() {
        super.onCreate()
        // 读取上次崩溃日志
        try {
            val fis = openFileInput(CRASH_FILE)
            crashLog = fis.bufferedReader().readText()
            fis.close()
        } catch (_: Exception) {}

        // 设置全局异常处理器
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                val sb = StringBuilder()
                sb.appendLine("=== Crash at ${java.util.Date()} ===")
                sb.appendLine("Thread: ${thread.name}")
                sb.appendLine("Exception: ${throwable.javaClass.name}: ${throwable.message}")
                sb.appendLine()
                sb.appendLine(throwable.stackTraceToString())
                // 也记录 cause
                var cause = throwable.cause
                while (cause != null) {
                    sb.appendLine()
                    sb.appendLine("Caused by: ${cause.javaClass.name}: ${cause.message}")
                    sb.appendLine(cause.stackTraceToString())
                    cause = cause.cause
                }
                val fos = openFileOutput(CRASH_FILE, Context.MODE_PRIVATE)
                fos.write(sb.toString().toByteArray())
                fos.close()
            } catch (_: Exception) {}
            // 自杀，让系统知道崩溃了
            Process.killProcess(Process.myPid())
            exitProcess(1)
        }
    }
}
