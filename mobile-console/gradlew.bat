@ECHO OFF
SETLOCAL
SET APP_HOME=%~dp0
IF DEFINED JAVA_HOME GOTO findJavaFromJavaHome
SET JAVA_EXE=java.exe
%JAVA_EXE% -version >NUL 2>&1
IF %ERRORLEVEL% EQU 0 GOTO execute
ECHO JAVA_HOME is not set and no java command is available. 1>&2
EXIT /B 1

:findJavaFromJavaHome
SET JAVA_HOME=%JAVA_HOME:"=%
SET JAVA_EXE=%JAVA_HOME%\bin\java.exe
IF EXIST "%JAVA_EXE%" GOTO execute
ECHO JAVA_HOME does not point to a valid JDK: %JAVA_HOME% 1>&2
EXIT /B 1

:execute
SET CLASSPATH=%APP_HOME%..\android-agent\gradle\wrapper\gradle-wrapper.jar
IF NOT EXIST "%CLASSPATH%" (
  ECHO Shared checked-in Gradle wrapper JAR was not found at %CLASSPATH% 1>&2
  EXIT /B 1
)
"%JAVA_EXE%" %JAVA_OPTS% %GRADLE_OPTS% "-Dorg.gradle.appname=gradlew" -classpath "%CLASSPATH%" org.gradle.wrapper.GradleWrapperMain %*
ENDLOCAL

